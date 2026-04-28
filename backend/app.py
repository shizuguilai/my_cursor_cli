"""
Cursor 远程控制台 - Flask 后端主应用
"""

import os
import sys
import threading
import uuid
from datetime import datetime

from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, disconnect

# 添加 backend 目录到 path
sys.path.insert(0, os.path.dirname(__file__))

from agent import execute, kill_agent, get_active_agents
import projects

# 初始化 Flask
app = Flask(__name__, static_folder='static')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'cursor-remote-secret-' + str(uuid.uuid4())[:8])
app.config['JSON_AS_ASCII'] = False

socketio = SocketIO(
    app,
    cors_allowed_origins='*',
    async_mode='threading',
    ping_timeout=60,
    ping_interval=25,
)

# 会话历史（内存存储）
# 结构: {session_id: {'id': session_id, 'workspace': path, 'model': str, 'created_at': timestamp, 'messages': []}}
sessions: dict = {}
sessions_lock = threading.Lock()

# 静态文件服务
@app.route('/')
def index():
    static_folder = app.config.get('STATIC_INDEX', 'frontend/dist')
    return send_from_directory(static_folder, 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory(os.path.join(app.root_path, 'static'), filename)


# ===== REST API =====

@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})


@app.route('/api/projects', methods=['GET'])
def api_list_projects():
    """获取所有工作区"""
    return jsonify({'projects': projects.get_projects()})


@app.route('/api/projects', methods=['POST'])
def api_add_project():
    """添加工作区"""
    data = request.get_json()
    name = data.get('name', '').strip()
    path = data.get('path', '').strip()
    description = data.get('description', '')
    
    if not name or not path:
        return jsonify({'error': 'name 和 path 不能为空'}), 400
    
    if not projects.validate_workspace_path(path):
        return jsonify({'error': '路径无效或存在安全隐患'}), 400
    
    result = projects.add_project(name, path, description)
    return jsonify(result), 201


@app.route('/api/projects/<name>', methods=['DELETE'])
def api_delete_project(name):
    """删除工作区"""
    if projects.remove_project(name):
        return jsonify({'ok': True})
    return jsonify({'error': '工作区不存在'}), 404


@app.route('/api/projects/default/<name>', methods=['PUT'])
def api_set_default_project(name):
    """设置默认工作区"""
    if projects.set_default_project(name):
        return jsonify({'ok': True})
    return jsonify({'error': '工作区不存在'}), 404


@app.route('/api/sessions', methods=['GET'])
def api_list_sessions():
    """获取所有会话"""
    with sessions_lock:
        active = get_active_agents()
        session_list = []
        for sid, sess in sessions.items():
            is_running = any(a['session_id'] == sid for a in active)
            session_list.append({
                'id': sid,
                'workspace': sess.get('workspace', ''),
                'model': sess.get('model', ''),
                'created_at': sess.get('created_at', ''),
                'is_running': is_running,
            })
        return jsonify({'sessions': session_list})


@app.route('/api/sessions/<session_id>', methods=['DELETE'])
def api_kill_session(session_id):
    """终止会话"""
    killed = kill_agent(session_id)
    return jsonify({'killed': killed})


# ===== WebSocket 事件 =====

@socketio.on('connect')
def on_connect():
    print(f'[SocketIO] 客户端连接: {request.sid}')


@socketio.on('disconnect')
def on_disconnect():
    print(f'[SocketIO] 客户端断开: {request.sid}')


@socketio.on('execute')
def on_execute(data):
    """
    执行 Cursor Agent 任务
    data: { workspace, prompt, model?, session_id? }
    """
    workspace = data.get('workspace', '')
    prompt = data.get('prompt', '')
    model = data.get('model', 'claude-sonnet-4-20250514')
    session_id = data.get('session_id') or str(uuid.uuid4())[:8]
    
    if not workspace or not prompt:
        emit('error', {'session_id': session_id, 'error': 'workspace 和 prompt 不能为空'})
        return
    
    # 验证工作区
    if not projects.validate_workspace_path(workspace):
        emit('error', {'session_id': session_id, 'error': '工作区路径无效'})
        return
    
    print(f'[Execute] session={session_id} workspace={workspace} prompt={prompt[:50]}...')
    
    # 记录会话
    with sessions_lock:
        sessions[session_id] = {
            'id': session_id,
            'workspace': workspace,
            'model': model,
            'created_at': datetime.now().isoformat(),
            'prompt': prompt,
        }
    
    # 广播会话列表更新
    emit('sessions_update', {'sessions': _get_sessions_list()})
    
    def on_progress(evt):
        """进度回调 - 通过 WebSocket 推送"""
        socketio.emit('output', {
            'session_id': evt.get('session_id', session_id),
            'type': evt.get('type', 'responding'),
            'content': evt.get('content', ''),
            'snippet': evt.get('snippet', ''),
            'elapsed': evt.get('elapsed', 0),
        }, room=request.sid)
    
    def on_done(evt):
        """完成回调"""
        socketio.emit('done', {
            'session_id': evt.get('session_id', session_id),
            'result': evt.get('result', ''),
            'tool_summary': evt.get('tool_summary', []),
        }, room=request.sid)
        # 更新会话记录
        with sessions_lock:
            if session_id in sessions:
                sessions[session_id]['completed_at'] = datetime.now().isoformat()
                sessions[session_id]['result'] = evt.get('result', '')[:500]
        # 广播会话列表
        emit('sessions_update', {'sessions': _get_sessions_list()})
    
    def on_error(error_msg):
        """错误回调"""
        socketio.emit('error', {
            'session_id': session_id,
            'error': error_msg,
        }, room=request.sid)
        with sessions_lock:
            if session_id in sessions:
                sessions[session_id]['error'] = error_msg
        emit('sessions_update', {'sessions': _get_sessions_list()})
    
    # 后台线程执行
    def run_agent():
        try:
            execute(
                workspace=workspace,
                prompt=prompt,
                model=model,
                session_id=session_id,
                on_progress=on_progress,
                on_done=on_done,
                on_error=on_error,
            )
        except Exception as e:
            on_error(str(e))
    
    thread = threading.Thread(target=run_agent, daemon=True)
    thread.start()
    
    # 立即返回 session_id
    emit('started', {
        'session_id': session_id,
        'status': 'started',
    })


@socketio.on('kill')
def on_kill(data):
    """终止任务"""
    session_id = data.get('session_id')
    if session_id:
        killed = kill_agent(session_id)
        emit('killed', {'session_id': session_id, 'killed': killed})


def _get_sessions_list():
    """获取会话列表（带活跃状态）"""
    active = get_active_agents()
    result = []
    for sid, sess in sessions.items():
        is_running = any(a['session_id'] == sid for a in active)
        result.append({
            'id': sid,
            'workspace': sess.get('workspace', ''),
            'model': sess.get('model', ''),
            'created_at': sess.get('created_at', ''),
            'is_running': is_running,
        })
    return result


# ===== 启动 =====

def main():
    port = int(os.environ.get('PORT', 5000))
    host = os.environ.get('HOST', '0.0.0.0')
    
    print(f'[Cursor Remote] 启动服务器 {host}:{port}')
    print(f'[Cursor Remote] Agent: /root/.local/bin/agent')
    print(f'[Cursor Remote] Projects: {projects.PROJECTS_FILE}')
    
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
