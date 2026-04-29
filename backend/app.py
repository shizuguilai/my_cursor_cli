"""
Cursor 远程控制台 - Flask 后端主应用
"""
import eventlet
eventlet.monkey_patch()

import os
import sys
import uuid
from datetime import datetime

from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, disconnect

# 添加 backend 目录到 path
sys.path.insert(0, os.path.dirname(__file__))

from agent import execute, kill_agent, get_active_agents
import projects
import session_store

# 初始化 Flask
app = Flask(__name__, static_folder='static', static_url_path='')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'cursor-remote-secret-' + str(uuid.uuid4())[:8])
app.config['JSON_AS_ASCII'] = False

socketio = SocketIO(
    app,
    cors_allowed_origins='*',
    async_mode='eventlet',
    ping_timeout=60,
    ping_interval=25,
    always_connect=True,
    logger=True,
)

session_store.init_db()

# ===== Auth =====
AUTH_TOKEN = (
    os.environ.get('CURSOR_REMOTE_TOKEN')
    or os.environ.get('AUTH_TOKEN')
)

if not AUTH_TOKEN:
    # 公网安全：不要使用可预测默认值；未配置时使用随机 token。
    AUTH_TOKEN = 'cursor-remote-token-' + str(uuid.uuid4())
    print(f'[Auth] WARNING: CURSOR_REMOTE_TOKEN 未设置，使用随机 token: {AUTH_TOKEN}', flush=True)


def _extract_token_from_request() -> str | None:
    """从 Authorization Bearer / 查询参数 token 中提取 token。"""
    auth_header = request.headers.get('Authorization', '') or ''
    auth_header_lower = auth_header.lower()
    if auth_header_lower.startswith('bearer '):
        token = auth_header[7:].strip()
        return token or None

    # 兼容 X-Auth-Token
    x_auth = request.headers.get('X-Auth-Token', '')
    if x_auth:
        return x_auth.strip()

    token = request.args.get('token')
    if token:
        return token.strip()

    return None


def _is_authenticated() -> bool:
    token = _extract_token_from_request()
    return bool(token and token == AUTH_TOKEN)


@app.before_request
def api_auth_middleware():
    """保护所有 /api/* 请求，除了 /api/auth/check。"""
    if request.method == 'OPTIONS':
        return None

    if not request.path.startswith('/api/'):
        return None

    # 放行 token 校验接口本身
    if request.path.rstrip('/') == '/api/auth/check':
        return None

    if not _is_authenticated():
        return jsonify({'ok': False, 'error': 'unauthorized'}), 401


# ===== Static files =====
# 静态文件服务
STATIC_DIR = os.path.join(os.path.dirname(__file__), 'static')

# 默认超时 30 分钟
DEFAULT_TIMEOUT = 30 * 60

@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory(os.path.join(app.root_path, 'static'), filename)

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    return send_from_directory(os.path.join(app.root_path, 'static', 'assets'), filename)


# ===== REST API =====

@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})


@app.route('/api/auth/check', methods=['GET'])
def api_auth_check():
    """校验 token 是否正确。"""
    token = _extract_token_from_request()
    if token and token == AUTH_TOKEN:
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'unauthorized'}), 401


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
    return jsonify({'sessions': _get_sessions_list()})


@app.route('/api/sessions/<session_id>', methods=['GET'])
def api_get_session(session_id):
    """获取会话详情和历史消息"""
    session = session_store.get_session(session_id)
    if not session:
        return jsonify({'error': '会话不存在'}), 404

    active = get_active_agents()
    session['is_running'] = any(a['session_id'] == session_id for a in active)
    return jsonify(session)


@app.route('/api/sessions/<session_id>', methods=['DELETE'])
def api_delete_session(session_id):
    """删除会话及其所有消息"""
    killed = kill_agent(session_id)
    deleted = session_store.delete_session(session_id)
    if not deleted:
        return jsonify({'error': '会话不存在'}), 404
    return jsonify({'ok': True, 'killed': killed})


# ===== WebSocket 事件 =====

@socketio.on('connect')
def on_connect(auth=None):
    token = None
    if isinstance(auth, dict):
        token = auth.get('token')

    if not token:
        token = _extract_token_from_request()

    if not token or token != AUTH_TOKEN:
        print('[Auth] Socket connect rejected (invalid token)', flush=True)
        return False

    print(f'[SocketIO] 客户端连接: {request.sid}')
    print(f'[SocketIO] 连接 URL: {request.url}')
    print(f'[SocketIO] 连接 Headers: {dict(request.headers)}')


@socketio.on('disconnect')
def on_disconnect():
    print(f'[SocketIO] 客户端断开: {request.sid}')


@socketio.on('execute')
def on_execute(data):
    """
    执行 Cursor Agent 任务
    data: { workspace, prompt, model?, session_id? }
    """
    print(f'[SocketIO] on_execute 收到数据: {data}')
    workspace = data.get('workspace', '')
    prompt = data.get('prompt', '')
    model = data.get('model', 'auto')
    session_id = data.get('session_id') or str(uuid.uuid4())[:8]

    if not workspace or not prompt:
        emit('error', {'session_id': session_id, 'error': 'workspace 和 prompt 不能为空'})
        return

    # 验证工作区
    if not projects.validate_workspace_path(workspace):
        emit('error', {'session_id': session_id, 'error': '工作区路径无效'})
        return

    print(f'[Execute] session={session_id} workspace={workspace} prompt={prompt[:50]}...')

    # 记录会话和用户消息
    session_store.upsert_session(session_id, workspace, model)
    session_store.add_message(session_id, 'user', prompt, snippet=prompt[:50], elapsed=0)

    # 立即发送 started 事件
    emit('started', {
        'session_id': session_id,
        'status': 'started',
    })

    # 广播会话列表更新
    emit('sessions_update', {'sessions': _get_sessions_list()})

    # 关键：在启动后台任务前抓取 sid，避免跨线程 request context 问题
    sid = request.sid

    def on_progress(evt):
        """进度回调 - 通过 WebSocket 推送"""
        try:
            sess_id = evt.get('session_id', session_id)
            content = evt.get('content', '')
            print(f'[Execute] on_progress called: session={sess_id} type={evt.get("type")} content={repr(content[:100])}')
            socketio.emit('output', {
                'session_id': sess_id,
                'type': evt.get('type', 'responding'),
                'content': content,
                'snippet': evt.get('snippet', ''),
                'elapsed': evt.get('elapsed', 0),
            }, room=sid)
            if content:
                session_store.add_message(
                    sess_id,
                    evt.get('type', 'responding'),
                    content,
                    snippet=evt.get('snippet', ''),
                    elapsed=evt.get('elapsed', 0),
                )
            print(f'[Execute] emitted output event for session={sess_id}')
        except Exception as e:
            print(f'[Execute] on_progress ERROR: {e}')
            import traceback
            traceback.print_exc()

    def on_done(evt):
        """完成回调"""
        print(f'[Execute] on_done called: session={evt.get("session_id", session_id)} result={repr(str(evt.get("result", ""))[:100])}')
        socketio.emit('done', {
            'session_id': evt.get('session_id', session_id),
            'result': evt.get('result', ''),
            'tool_summary': evt.get('tool_summary', []),
        }, room=sid)
        print(f'[Execute] emitted done event for session={evt.get("session_id", session_id)}')
        # 更新会话记录
        session_store.mark_session_done(session_id, evt.get('result', ''))
        # 广播会话列表
        socketio.emit('sessions_update', {'sessions': _get_sessions_list()}, room=sid)

    def on_error(error_msg):
        """错误回调"""
        print(f'[Execute] on_error called: session={session_id} error={error_msg}')
        socketio.emit('error', {
            'session_id': session_id,
            'error': error_msg,
        }, room=sid)
        session_store.mark_session_error(session_id, error_msg)
        socketio.emit('sessions_update', {'sessions': _get_sessions_list()}, room=sid)

    # 使用 socketio.start_background_task 代替 threading.Thread
    # 这样 Flask-SocketIO 会自动在正确的 eventlet 上下文中管理 session
    def run_agent_task():
        try:
            execute(
                workspace=workspace,
                prompt=prompt,
                model=model,
                session_id=session_id,
                timeout=DEFAULT_TIMEOUT,
                on_progress=on_progress,
                on_done=on_done,
                on_error=on_error,
            )
        except Exception as e:
            print(f'[Execute] run_agent exception: {e}')
            on_error(f'执行异常: {e}')

    # socketio.start_background_task 会让回调在 SocketIO 的 greenlet 上下文中运行
    socketio.start_background_task(run_agent_task)


@socketio.on('kill')
def on_kill(data):
    """终止任务"""
    print(f'[SocketIO] on_kill 收到数据: {data}')
    session_id = data.get('session_id')
    if session_id:
        killed = kill_agent(session_id)
        emit('killed', {'session_id': session_id, 'killed': killed})


def _get_sessions_list():
    """获取会话列表(带活跃状态)"""
    active = get_active_agents()
    db_sessions = session_store.list_sessions()
    result = []
    for sess in db_sessions:
        sid = sess.get('id', '')
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