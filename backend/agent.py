"""
Cursor Agent CLI 执行器
参考 cursor-remote-control/shared/agent-executor.ts 重写为 Python 版本
"""

import json
import os
import subprocess
import threading
import uuid
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable, Dict, Any, List

AGENT_BIN = os.environ.get('AGENT_BIN', '/root/.local/bin/agent')
DEFAULT_TIMEOUT = 30 * 60  # 30 分钟
DEFAULT_MAX_CONCURRENT = 10
PROGRESS_INTERVAL = 2  # 秒

# 全局活跃任务
active_agents: Dict[str, 'AgentProcess'] = {}
_active_lock = threading.Lock()


class AgentProcess:
    def __init__(self, session_id: str, pid: int, process: subprocess.Popen,
                 workspace: str, start_time: float):
        self.session_id = session_id
        self.pid = pid
        self.process = process
        self.workspace = workspace
        self.start_time = start_time
        self.done = False
        self.manually_killed = False

    def kill(self):
        try:
            self.process.terminate()
            time.sleep(0.5)
            try:
                os.kill(self.pid, 0)  # 检查进程是否还在
                self.process.kill()
            except (ProcessLookupError, PermissionError):
                pass
        except Exception:
            pass

    def abort(self):
        self.manually_killed = True
        self.kill()


def cleanup_finished_agents():
    """清理已结束的进程记录"""
    with _active_lock:
        for sid, agent in list(active_agents.items()):
            if agent.done:
                del active_agents[sid]


def get_active_agents() -> List[Dict[str, Any]]:
    """获取当前活跃任务列表"""
    with _active_lock:
        return [
            {
                'session_id': sid,
                'pid': a.pid,
                'workspace': a.workspace,
                'running_time': int(time.time() - a.start_time),
            }
            for sid, a in active_agents.items()
        ]


def kill_agent(session_id: str) -> bool:
    """手动终止任务"""
    with _active_lock:
        if session_id in active_agents:
            active_agents[session_id].abort()
            return True
    return False


def kill_all():
    """终止所有任务"""
    with _active_lock:
        for sid, agent in active_agents.items():
            agent.abort()


def execute(
    workspace: str,
    prompt: str,
    model: str = 'claude-sonnet-4-20250514',
    session_id: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    on_progress: Optional[Callable[[dict], None]] = None,
    on_done: Optional[Callable[[dict], None]] = None,
    on_error: Optional[Callable[[str], None]] = None,
) -> str:
    """
    执行 Cursor Agent 任务
    
    Args:
        workspace: 工作区路径
        prompt: 执行的 prompt
        model: 模型名称
        session_id: 会话 ID（用于恢复）
        api_key: API Key（可选）
        timeout: 超时时间（秒）
        on_progress: 进度回调 {session_id, type, content, snippet, elapsed}
        on_done: 完成回调 {session_id, result, session_id}
        on_error: 错误回调 {session_id, error}
    
    Returns:
        session_id
    """
    if not session_id:
        session_id = str(uuid.uuid4())[:8]
    
    workspace_abs = str(Path(workspace).resolve())
    
    # 检查 workspace 是否有效
    if not workspace_abs or workspace_abs == '.' or 'undefined' in workspace_abs.lower():
        raise ValueError(f"Workspace 无效: {workspace}")
    
    # 构建 CLI 参数
    args = [
        AGENT_BIN,
        '-p', '--force', '--trust', '--approve-mcps',
        '--workspace', workspace_abs,
        '--model', model,
        '--output-format', 'stream-json',
        '--stream-partial-output',
    ]
    
    if session_id:
        args.extend(['--resume', session_id])
    
    args.extend(['--', prompt])
    
    # 构建环境变量
    env = os.environ.copy()
    if api_key:
        env['CURSOR_API_KEY'] = api_key
    
    # 启动进程
    print(f"[Agent] Spawning: {' '.join(args[:6])}... workspace={workspace_abs}")
    
    try:
        process = subprocess.Popen(
            args,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=False,  # binary mode for JSON streaming
            bufsize=1,
        )
    except Exception as e:
        raise RuntimeError(f"Agent 进程启动失败: {e}")
    
    if not process.pid:
        raise RuntimeError("Agent 进程启动失败: pid 为空")
    
    pid = process.pid
    
    # 注册活跃任务
    agent = AgentProcess(session_id, pid, process, workspace_abs, time.time())
    with _active_lock:
        active_agents[session_id] = agent
    
    def read_stdout():
        line_buf = b''
        assistant_buf = ''
        last_segment = ''
        tool_summary: List[str] = []
        phase = 'thinking'
        last_output_time = time.time()
        timeout_timer = time.time() + timeout
        session_id_from_cli = session_id
        
        try:
            while True:
                if agent.done or agent.manually_killed:
                    break
                
                # 检查超时
                if time.time() > timeout_timer:
                    print(f"[Agent] 超时终止 ({timeout}s) session={session_id}")
                    agent.kill()
                    if on_error:
                        on_error(f"Agent 运行超时 ({timeout // 60}分钟)，已强制终止")
                    break
                
                # 读取一行
                char = process.stdout.read(1)
                if not char:
                    # 进程结束
                    break
                
                line_buf += char
                if char == b'\n':
                    line = line_buf.decode('utf-8', errors='replace').strip()
                    line_buf = b''
                    
                    if not line:
                        continue
                    
                    last_output_time = time.time()
                    
                    # 解析 JSON
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    
                    ev_type = ev.get('type', '')
                    
                    if ev_type == 'session_id':
                        session_id_from_cli = ev.get('session_id', session_id)
                        continue
                    
                    # 确定阶段
                    if ev_type == 'thinking':
                        phase = 'thinking'
                    elif ev_type == 'assistant':
                        phase = 'responding'
                        content_parts = []
                        message = ev.get('message', {})
                        for c in message.get('content', []):
                            if isinstance(c, dict) and c.get('type') == 'text':
                                text = c.get('text', '')
                                if text:
                                    content_parts.append(text)
                                    assistant_buf += text
                                    last_segment = text
                        content = ''.join(content_parts)
                    elif ev_type == 'tool_call':
                        phase = 'tool_call'
                        tool_call = ev.get('tool_call', {})
                        if ev.get('subtype') == 'started':
                            desc = describe_tool_call(tool_call)
                            tool_summary.append(desc)
                        # 提取工具名称
                        tool_name = ''
                        if isinstance(tool_call, dict):
                            tool_name = list(tool_call.keys())[0] if tool_call else ''
                        content = f"[工具调用] {tool_name}" if tool_name else "[工具调用]"
                    else:
                        content = ''
                    
                    # 回调进度
                    if on_progress and phase:
                        elapsed = int(time.time() - agent.start_time)
                        # 获取最后几行作为 snippet
                        lines = [l.strip() for l in assistant_buf.split('\n') if l.strip()]
                        snippet = '\n'.join(lines[-4:]) if lines else ''
                        on_progress({
                            'session_id': session_id_from_cli,
                            'type': phase,
                            'content': content,
                            'snippet': snippet,
                            'elapsed': elapsed,
                        })
                    
                    # 处理 result
                    if ev_type == 'result':
                        result_text = ev.get('result', '')
                        if isinstance(result_text, str):
                            result_text = result_text.strip()
                        else:
                            result_text = str(result_text)
                        
                        if ev.get('subtype') == 'error':
                            if on_error:
                                on_error(result_text)
                        else:
                            final_output = result_text or last_segment.strip() or assistant_buf.strip()
                            if on_done:
                                on_done({
                                    'session_id': session_id_from_cli,
                                    'result': final_output,
                                    'tool_summary': tool_summary,
                                })
                        agent.done = True
                        break
                
                # 无输出超时检测（5分钟无输出）
                idle_time = time.time() - last_output_time
                if idle_time > 300 and not agent.done:
                    print(f"[Agent] {idle_time/60:.0f}分钟无输出，强制终止 session={session_id}")
                    agent.kill()
                    if on_error:
                        on_error(f"任务 {idle_time/60:.0f}分钟无响应，已强制终止。可能原因：等待外部服务响应、陷入死循环或卡在用户输入")
                    break
        except Exception as e:
            print(f"[Agent] stdout 读取异常: {e}")
            agent.kill()
            if on_error:
                on_error(str(e))
        finally:
            # 进程结束
            agent.done = True
            with _active_lock:
                if session_id in active_agents:
                    del active_agents[session_id]
            
            # 确保进程已终止
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
    
    thread = threading.Thread(target=read_stdout, daemon=True)
    thread.start()
    
    return session_id


def describe_tool_call(tool_call: dict) -> str:
    """工具调用描述"""
    if not tool_call:
        return "未知工具"
    
    name = list(tool_call.keys())[0] if tool_call else '未知工具'
    args = tool_call.get(name, {}) if isinstance(tool_call, dict) else {}
    
    if name == 'Shell':
        cmd = args.get('command', '') if isinstance(args, dict) else ''
        return f"执行命令: {cmd[:80]}"
    elif name == 'Read':
        path = args.get('path', '') if isinstance(args, dict) else ''
        return f"读取文件: {path.split('/')[-1]}"
    elif name == 'Write':
        path = args.get('path', '') if isinstance(args, dict) else ''
        return f"写入文件: {path.split('/')[-1]}"
    elif name == 'StrReplace':
        path = args.get('path', '') if isinstance(args, dict) else ''
        return f"编辑文件: {path.split('/')[-1]}"
    elif name == 'Grep':
        pattern = args.get('pattern', '') if isinstance(args, dict) else ''
        return f"搜索代码: {pattern}"
    elif name == 'Glob':
        pattern = args.get('glob_pattern', '') if isinstance(args, dict) else ''
        return f"查找文件: {pattern}"
    else:
        return f"调用工具: {name}"
