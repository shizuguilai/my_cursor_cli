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
import select
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
# 记录每个 session 已发送给前端的完整响应文本
# 用于在流式事件中稳定计算可安全追加的 delta，避免重复与回退累积错误
sent_assistant_content: Dict[str, str] = {}

# 诊断日志文件
DIAG_LOG = '/tmp/agent_diag.log'


def _diag(msg: str):
    """诊断日志"""
    ts = time.strftime('%H:%M:%S')
    line = f"[{ts}] {msg}\n"
    with open(DIAG_LOG, 'a') as f:
        f.write(line)
    print(f'[DIAG] {msg}', flush=True)


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
        session_id: 会话 ID(用于恢复)
        api_key: API Key(可选)
        timeout: 超时时间(秒)
        on_progress: 进度回调 {session_id, type, content, snippet, elapsed}
        on_done: 完成回调 {session_id, result, session_id}
        on_error: 错误回调 {session_id, error}

    Returns:
        session_id
    """
    # 每次执行清空诊断日志
    with open(DIAG_LOG, 'w') as f:
        f.write('')

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
    _diag(f'Spawning: {" ".join(args[:6])}... workspace={workspace_abs}')
    _diag(f'Full args: {args}')
    try:
        process = subprocess.Popen(
            args,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=False,  # binary mode for JSON streaming
            bufsize=0,   # 无缓冲，直接从 pipe 读
        )
    except Exception as e:
        raise RuntimeError(f"Agent 进程启动失败: {e}")

    # 关键修复：eventlet 对 subprocess pipe 有特殊处理问题，
    # 显式设置 stdout/stderr 为 blocking 模式
    # Python 3.12+: os.set_blocking(fd, blocking)
    set_blocking = getattr(os, 'set_blocking', None) or getattr(os, 'set_blocking_fd', None)
    if set_blocking:
        try:
            fd = process.stdout.fileno()
            old_blocking = os.get_blocking(fd)
            if not old_blocking:
                set_blocking(fd, True)
                _diag(f'set stdout blocking=True (was {old_blocking})')
        except (AttributeError, OSError) as ex:
            _diag(f'set_blocking stdout failed: {ex}')

        try:
            fd = process.stderr.fileno()
            old_blocking = os.get_blocking(fd)
            if not old_blocking:
                set_blocking(fd, True)
                _diag(f'set stderr blocking=True (was {old_blocking})')
        except (AttributeError, OSError) as ex:
            _diag(f'set_blocking stderr failed: {ex}')

    if not process.pid:
        raise RuntimeError("Agent 进程启动失败: pid 为空")

    pid = process.pid

    # 注册活跃任务
    agent = AgentProcess(session_id, pid, process, workspace_abs, time.time())
    with _active_lock:
        active_agents[session_id] = agent

    # 任意退出路径只通知一次 on_done/on_error，避免子进程无 result 行就 EOF 时前端一直「执行中」
    notify_state = {'sent': False}

    def safe_done(result: str, tool_summary: Optional[List[str]] = None):
        if notify_state['sent']:
            return
        notify_state['sent'] = True
        if on_done:
            try:
                on_done({
                    'session_id': session_id,
                    'result': result or '',
                    'tool_summary': list(tool_summary) if tool_summary is not None else [],
                })
            except Exception as e:
                _diag(f'safe_done exception: {e}')

    def safe_err(msg: str):
        if notify_state['sent']:
            return
        notify_state['sent'] = True
        if on_error:
            try:
                on_error(msg)
            except Exception as e:
                _diag(f'safe_err exception: {e}')

    # 汇总 agent 子进程 stderr，便于无 result 退出时在错误里直接展示真实原因（如 TLS/代理）
    stderr_tail_lock = threading.Lock()
    stderr_fragments: List[str] = []

    def append_agent_stderr(part: str):
        if not part:
            return
        with stderr_tail_lock:
            stderr_fragments.append(part)
            joined = ''.join(stderr_fragments)
            if len(joined) > 16000:
                stderr_fragments.clear()
                stderr_fragments.append(joined[-8000:])

    def get_agent_stderr_tail(max_chars: int = 4000) -> str:
        with stderr_tail_lock:
            s = ''.join(stderr_fragments).strip()
            return s[-max_chars:] if len(s) > max_chars else s

    _diag(f'Subprocess started pid={pid} session={session_id} stdout_fileno={process.stdout.fileno()} stderr_fileno={process.stderr.fileno()}')

    # 用 select 配合 readline 实现高效读取，避免逐字节 read(1) 的低效问题
    def read_stdout():
        line_buf = b''
        assistant_buf = ''
        last_segment = ''
        tool_summary: List[str] = []
        phase = 'thinking'
        last_output_time = time.time()
        timeout_timer = time.time() + timeout
        session_id_from_cli = session_id

        _diag('read_stdout thread started')

        try:
            while True:
                if agent.done or agent.manually_killed:
                    _diag(f'breaking: done={agent.done} manually_killed={agent.manually_killed}')
                    break

                # 检查超时
                if time.time() > timeout_timer:
                    _diag(f'TIMEOUT ({timeout}s) session={session_id}')
                    agent.kill()
                    safe_err(f"Agent 运行超时 ({timeout // 60}分钟),已强制终止")
                    break

                # 使用 select.select 等待数据（eventlet 下 poll 不可用，用 select 代替）
                try:
                    ready, _, _ = select.select([process.stdout], [], [], 1.0)
                except OSError as e:
                    _diag(f'select.select OSError: {e}')
                    break

                if not ready:
                    # select 超时，检测空闲
                    idle_time = time.time() - last_output_time
                    if idle_time > 300 and not agent.done:
                        _diag(f'{idle_time/60:.0f}分钟无输出,强制终止 session={session_id}')
                        agent.kill()
                        safe_err(
                            f"任务 {idle_time/60:.0f}分钟无响应,已强制终止。"
                            "可能原因:等待外部服务响应、陷入死循环或卡在用户输入"
                        )
                    continue

                # 有数据可读，尝试读一行
                try:
                    char = os.read(process.stdout.fileno(), 4096)
                except OSError as e:
                    _diag(f'os.read OSError: {e}')
                    break

                if not char:
                    _diag('stdout EOF (no char returned)')
                    break

                _diag(f'read {len(char)} bytes from stdout')

                # 追加到行缓冲区并提取完整行
                line_buf += char
                while b'\n' in line_buf:
                    line, line_buf = line_buf.split(b'\n', 1)
                    line = line.decode('utf-8', errors='replace').strip()
                    if not line:
                        continue

                    last_output_time = time.time()
                    _diag(f'line: {line[:120]}')

                    # 解析 JSON
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        _diag(f'JSON parse failed: {line[:80]}')
                        continue

                    ev_type = ev.get('type', '')

                    if ev_type == 'init':
                        session_id_from_cli = ev.get('session_id', session_id)
                        _diag(f'got init, session_id={session_id_from_cli}')
                        continue

                    # 确定阶段
                    delta = ''
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
                                    last_segment = text
                        content = ''.join(content_parts)
                        prev_full = sent_assistant_content.get(session_id_from_cli, '')

                        if not content:
                            # 空 content：跳过
                            delta = ''
                            assistant_buf = prev_full
                        elif content == prev_full and len(content) >= 2:
                            # 完整重发（流式输出结束后 CLI 会再发一次「全量 assistant」事件）：跳过
                            # 注意只在 len>=2 时去重，避免吞掉 'a'+'a' 这种连续单字
                            delta = ''
                            assistant_buf = prev_full
                        elif len(content) > len(prev_full) and content.startswith(prev_full):
                            # 累积模式：本次比上次长且以上次为前缀 → 多出来的尾部是新增
                            delta = content[len(prev_full):]
                            assistant_buf = content
                            sent_assistant_content[session_id_from_cli] = assistant_buf
                        else:
                            # 分片模式：每条事件就是一段新增 token，直接追加
                            # 不能按 prev_full.endswith(content) 去重，否则会吞掉
                            # 像 “轻轻” 这种合法的连续相同字符片段。
                            delta = content
                            assistant_buf = prev_full + content
                            sent_assistant_content[session_id_from_cli] = assistant_buf
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
                        delta = content
                    else:
                        content = ''

                    # 回调进度
                    if on_progress and phase:
                        _diag(f'on_progress phase={phase} content={repr(content[:80]) if content else ""}')
                        elapsed = int(time.time() - agent.start_time)
                        # 获取最后几行作为 snippet
                        lines = [l.strip() for l in assistant_buf.split('\n') if l.strip()]
                        snippet = '\n'.join(lines[-4:]) if lines else ''
                        try:
                            on_progress({
                                'session_id': session_id,
                                'type': phase,
                                'content': content,
                                'delta': delta,
                                'snippet': snippet,
                                'elapsed': elapsed,
                            })
                            _diag(f'on_progress called OK')
                        except Exception as e:
                            _diag(f'on_progress exception: {e}')

                    # 处理 result
                    if ev_type == 'result':
                        _diag(f'got result: subtype={ev.get("subtype")} result={repr(str(ev.get("result", ""))[:100])}')
                        result_text = ev.get('result', '')
                        if isinstance(result_text, str):
                            result_text = result_text.strip()
                        else:
                            result_text = str(result_text)

                        if ev.get('subtype') == 'error':
                            safe_err(result_text or 'Agent 返回错误')
                        else:
                            final_output = result_text or last_segment.strip() or assistant_buf.strip()
                            safe_done(final_output, tool_summary)
                            _diag('on_done called OK')
                        agent.done = True
                        break

        except Exception as e:
            _diag(f'stdout 读取异常: {e}')
            agent.kill()
            safe_err(str(e))
        finally:
            _diag('read_stdout exiting')
            # 进程结束
            agent.done = True
            sent_assistant_content.pop(session_id_from_cli, None)
            with _active_lock:
                if session_id in active_agents:
                    del active_agents[session_id]

            # 子进程在从未输出 type=result 的行就退出时，必须补发 done/error，否则前端一直「执行中」
            if not notify_state['sent']:
                if agent.manually_killed:
                    safe_done(assistant_buf.strip())
                elif assistant_buf.strip():
                    safe_done(assistant_buf.strip(), tool_summary)
                else:
                    tail = get_agent_stderr_tail()
                    if tail:
                        safe_err(
                            'Agent 已退出，未收到 result 结束事件。子进程 stderr 如下：\n\n'
                            + tail
                            + '\n\n'
                            '常见处理：若出现 TLS/代理相关报错，请检查 http(s)_proxy 指向的代理(如 127.0.0.1:7890)是否可用，'
                            '或在启动后端的 systemd/screen 环境中 unset HTTP_PROXY/HTTPS_PROXY/all_proxy 后重试；'
                            '并确认已登录 Cursor CLI 或已配置 CURSOR_API_KEY。完整诊断见 /tmp/agent_diag.log'
                        )
                    else:
                        safe_err(
                            'Agent 已退出，未收到 result 结束事件，且无 stderr 捕获（请查看 /tmp/agent_diag.log）。'
                            '常见原因：网络/TLS、代理、CURSOR_API_KEY 或 agent CLI 异常。'
                        )

            # 确保进程已终止
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _diag('process.kill() called')
                process.kill()

    thread = threading.Thread(target=read_stdout, daemon=True)
    thread.start()

    # 如果进程在启动后短时间内退出（说明立即失败了），
    # read_stdout 可能来不及检测。需要额外检查。
    def check_early_exit():
        time.sleep(3)  # 等待 3 秒
        if agent.done:
            return  # 已经正常结束了
        poll_result = process.poll()
        if poll_result is not None:
            # 进程已经退出但 agent.done 还为 False（还没有通过 read_stdout 检测到退出）
            _diag(f'Process exited early with code={poll_result}')
            # 读取 stderr 获取错误信息
            try:
                stderr_data = process.stderr.read()
                if stderr_data:
                    stderr_text = stderr_data.decode('utf-8', errors='replace').strip()
                    _diag(f'Early exit stderr: {stderr_text[:500]}')
                    safe_err(stderr_text if stderr_text else f'Agent 进程已退出 (code={poll_result})')
                else:
                    safe_err(f'Agent 进程已退出 (code={poll_result})，且无 stderr 输出')
            except Exception as e:
                _diag(f'read early stderr failed: {e}')
                safe_err(f'Agent 进程已退出 (code={poll_result})，读取 stderr 失败: {e}')
            agent.done = True

    early_check_thread = threading.Thread(target=check_early_exit, daemon=True)
    early_check_thread.start()

    # 启动 stderr 读取线程（防止 pipe 阻塞）
    def read_stderr():
        _diag('read_stderr thread started')
        try:
            buf = b''
            while True:
                try:
                    ready, _, _ = select.select([process.stderr], [], [], 1.0)
                except OSError:
                    break
                if not ready:
                    # 检查进程是否结束
                    if process.poll() is not None:
                        # 读取剩余数据
                        remaining = process.stderr.read()
                        if remaining:
                            for line in remaining.decode('utf-8', errors='replace').split('\n'):
                                if line.strip():
                                    _diag(f'[stderr] {line}')
                                    append_agent_stderr(line + '\n')
                        break
                    continue
                try:
                    data = os.read(process.stderr.fileno(), 2048)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                # 按行输出
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    dec = line.decode('utf-8', errors='replace')
                    _diag(f'[stderr] {dec}')
                    append_agent_stderr(dec + '\n')
                # 处理最后没有换行符的
                if buf:
                    dec = buf.decode('utf-8', errors='replace')
                    _diag(f'[stderr] {dec}')
                    append_agent_stderr(dec + '\n')
        except Exception as e:
            _diag(f'read_stderr exception: {e}')
        finally:
            _diag('read_stderr thread exiting')

    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stderr_thread.start()

    _diag(f'Agent.started pid={pid} session={session_id}')
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
