# Cursor 远程控制台 - 项目规格

## 1. 项目概述

- **项目名**：Cursor 远程控制台（cursor-remote-web）
- **功能**：通过网页远程控制 Cursor Agent，执行代码任务，实时查看输出
- **架构**：React 前端 + Flask 后端 + Cursor Agent CLI
- **运行位置**：服务器 Linux（root 用户，Python 3.12）

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + TailwindCSS |
| 后端 | Python 3.12 + Flask + Flask-SocketIO |
| 实时通信 | Socket.IO（WebSocket） |
| 执行层 | Cursor Agent CLI（`/root/.local/bin/agent`） |
| 工作区管理 | JSON 配置文件 |

## 3. 目录结构

```
my_cursor_cli/
├── SPEC.md                    # 本规格文档
├── backend/
│   ├── app.py                 # Flask 主应用 + SocketIO
│   ├── agent.py               # Cursor CLI 执行器（参考 shared/agent-executor.ts）
│   ├── projects.py             # 工作区管理（projects.json）
│   ├── requirements.txt        # Python 依赖
│   └── static/                 # 前端构建产物（Vite build 后）
├── frontend/
│   ├── src/
│   │   ├── App.tsx             # 主页面
│   │   ├── main.tsx
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx    # 聊天输入/输出面板
│   │   │   ├── OutputStream.tsx  # 流式输出显示
│   │   │   ├── SessionList.tsx   # 会话列表
│   │   │   └── ProjectSelector.tsx
│   │   └── lib/
│   │       └── socket.ts        # Socket.IO 客户端
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── tailwind.config.js
├── package.json                # 根目录 npm scripts
└── README.md
```

## 4. 后端 API 设计

### 4.1 REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 获取所有工作区 |
| POST | `/api/projects` | 添加工作区 |
| DELETE | `/api/projects/<name>` | 删除工作区 |
| GET | `/api/sessions` | 获取所有会话 |
| POST | `/api/execute` | 执行任务（非流式，用于启动）|
| DELETE | `/api/sessions/<session_id>` | 终止会话 |
| GET | `/api/health` | 健康检查 |

### 4.2 WebSocket 事件

**客户端 → 服务端：**
- `execute`: 发送执行命令 `{ workspace, prompt, session_id?, model }`
- `kill`: 终止任务 `{ session_id }`

**服务端 → 客户端：**
- `output`: 流式输出片段 `{ session_id, type: 'thinking'|'tool_call'|'responding', content, snippet }`
- `done`: 任务完成 `{ session_id, result, session_id: new }`
- `error`: 错误 `{ session_id, error }`
- `sessions`: 会话列表更新 `{ sessions: [...] }`

### 4.3 请求/响应示例

**POST /api/execute**
```json
// Request
{ "workspace": "/root/project", "prompt": "帮我写一个 hello world", "model": "claude-sonnet-4-20250514" }

// Response (HTTP 202)
{ "session_id": "sess_abc123", "status": "started" }
```

## 5. 前端页面设计

### 5.1 页面布局

```
┌──────────────────────────────────────────────┐
│  Header: Cursor 远程控制台    [工作区▼] [新建]│
├────────────┬─────────────────────────────────┤
│ 会话列表   │  主聊天/输出区                   │
│            │  ┌─────────────────────────────┐  │
│ sess_001   │  │ AI: 正在思考...            │  │
│ sess_002   │  │ 🔧 执行: ls -la            │  │
│ sess_003   │  │ AI: 结果是...              │  │
│            │  └─────────────────────────────┘  │
│            │  ┌─────────────────────────────┐  │
│            │  │ 输入框...        [发送]    │  │
│            │  └─────────────────────────────┘  │
└────────────┴─────────────────────────────────┘
```

### 5.2 组件说明

- **Header**: 标题 + 工作区选择下拉 + 新建会话按钮
- **ChatPanel**: 显示 AI 输出，支持 thinking/tool_call/responding 三种样式区分
- **OutputStream**: 实时显示流式输出，syntax highlighting
- **SessionList**: 左侧会话列表，点击切换，高亮当前会话
- **ProjectSelector**: 工作区管理，可添加/删除工作区路径

### 5.3 样式

- 深色主题（类似 Cursor IDE）
- TailwindCSS 原子化样式
- Monaco Editor 风格的输出面板

## 6. 后端核心逻辑

### 6.1 Cursor Agent 执行器（agent.py）

参考 `cursor-remote-control/shared/agent-executor.ts`，用 Python 重写：

- 使用 `subprocess.Popen` 启动 `agent` CLI
- 解析 JSON 流（`--output-format stream-json`）
- 支持：`--workspace`、`--model`、`--resume`、`--` + prompt
- 环境变量：`CURSOR_API_KEY`（可选）
- 超时：默认 30 分钟
- 并发限制：最多 10 个并发任务
- 流式输出通过 SocketIO 实时推送

### 6.2 工作区管理（projects.json）

```json
{
  "projects": {
    "默认项目": {
      "path": "/root/.openclaw/workspace",
      "description": "OpenClaw 工作区"
    }
  },
  "default_project": "默认项目"
}
```

### 6.3 会话管理

- 每个执行任务有唯一 `session_id`（UUID）
- 支持 `--resume` 恢复历史会话
- 会话队列：同工作区串行执行，不同工作区可并发

## 7. 安全考虑

- 工作区路径白名单校验（禁止 `..` 路径遍历）
- Shell 命令超时保护
- API Key 不暴露（通过 agent login 登录）
- 不记录敏感信息

## 8. 依赖

### 后端（requirements.txt）

```
flask>=3.0.0
flask-socketio>=5.3.0
python-socketio>=5.10.0
eventlet>=0.35.0
```

### 前端（package.json）

```
react, react-dom: ^18.2.0
typescript: ^5.3.0
vite: ^5.0.0
@tailwindcss/vite: ^4.0.0
socket.io-client: ^4.6.0
lucide-react: ^0.300.0
```

## 9. 运行方式

### 后端

```bash
cd backend
pip install -r requirements.txt
python3 app.py
# 默认端口 5000
```

### 前端

```bash
cd frontend
npm install
npm run dev   # 开发模式
npm run build # 构建到 backend/static
```

### 一键启动

```bash
# 启动后端（eventlet）
cd backend && python3 app.py &

# 启动前端开发服务器
cd frontend && npm run dev
```

## 10. 参考项目

- `cursor-remote-control`（已克隆到 `/root/.openclaw/workspace/cursor-remote-control`）
  - 核心参考：`shared/agent-executor.ts`（执行器逻辑）
  - 架构参考：`docs/ARCHITECTURE.md`
  - 关键文件：`shared/feilian-control.ts`（VPN 状态检测，简化参考）
