# Cursor 远程控制台

通过网页远程控制 Cursor Agent，实时执行代码任务，查看流式输出。

## 架构

```
┌─────────────────────┐      WebSocket       ┌─────────────────────┐
│   React 前端         │ ───────────────────▶ │   Flask 后端         │
│   (浏览器)           │ ◀────────────────── │   (Python)           │
│   Vite + Tailwind   │    Socket.IO         │   + eventlet         │
└─────────────────────┘                      └──────────┬──────────┘
                                                         │
                                                         │ subprocess
                                                         ▼
                                              ┌─────────────────────┐
                                              │   Cursor Agent CLI   │
                                              │   /root/.local/bin/  │
                                              └─────────────────────┘
```

## 当前功能一览

| 模块 | 能力 |
|------|------|
| **鉴权** | 固定 Token（`CURSOR_REMOTE_TOKEN` / `AUTH_TOKEN`）；前端 `localStorage` 持久化；`/api/*` 与 Socket.IO 均需携带 token |
| **工作区** | 读取 `projects.json`；列表、添加、删除、设置默认；路径校验 |
| **会话** | SQLite 持久化（`backend/sessions.sqlite3`）；列表、详情、删除、重命名（PATCH）；新建后由模型生成简短中文标题 |
| **执行** | Socket.IO `execute`：在选定工作区目录下拉起 Cursor Agent；流式事件 `thinking` / `tool_call` / `responding` / `done` / `error` / `killed` |
| **聊天 UI** | 左侧会话列表 + 可折叠侧栏；右侧消息流；执行中可 `kill` 终止；流式回复末尾闪烁光标 |
| **Markdown** | 用户消息、回复、思考、工具摘要等使用 **GFM**（表格、任务列表、删除线等）渲染 |
| **代码高亮** | 围栏代码块：`react-syntax-highlighter`（Prism 按需语言）+ **oneLight** 主题；白底容器；行内 `` `code` `` 仍为小灰底标签样式 |
| **静态资源** | `npm run build` 产物直接输出到 `backend/static/`（Vite `outDir` + `emptyOutDir`）；`/` 的 `index.html` **禁用强缓存**；`/assets/*` 下带 hash 的 js/css **长期缓存** |

## 快速启动

### 后端

> Token 鉴权：启动后端前请先配置 `CURSOR_REMOTE_TOKEN`（或 `AUTH_TOKEN`），否则后端会在每次启动时生成一个随机 token。

```bash
cd backend
pip install -r requirements.txt
export CURSOR_REMOTE_TOKEN="你的访问 token"
# 启动方式 1：直接运行（适合本地调试）
python3 app.py
```

或者：

```bash
# 进入 my_cursor_cli 根目录（把路径换成你的）
cd /path/to/my_cursor_cli
export CURSOR_REMOTE_TOKEN="你的访问 token"
# 启动方式 2：推荐（使用 gunicorn + eventlet，更贴近生产环境）
./start.sh
```

### 前端（开发模式）

```bash
cd frontend
npm install
npm run dev
```

开发时访问 http://localhost:5173（Vite 已将 `/api` 与 `/socket.io` 代理到后端，默认 `http://localhost:5000`）。

### 构建前端（与后端一并部署）

```bash
cd frontend
npm run build
```

构建产物写入 **`backend/static/`**，无需再手动拷贝 `dist`。部署或本地联调时：先 build，再启动 Flask，浏览器打开后端根路径即可。

## 配置

工作区配置：`projects.json`

```json
{
  "projects": {
    "我的项目": {
      "path": "/path/to/project",
      "description": "项目描述"
    }
  },
  "default_project": "我的项目"
}
```

### Token 鉴权（访问令牌）

该项目使用一个“固定 token”做访问控制，前端需要提供同一个 token 才能访问 `/api/*` 和建立 Socket.IO 连接。

1. 后端 token 来源（配置方式）
   - 后端会读取环境变量：
     - `CURSOR_REMOTE_TOKEN`（优先）
     - 或 `AUTH_TOKEN`
   - 如果两者都未设置，后端会自动生成随机 token，并在启动日志中打印告警。

2. 前端 token 流程（怎么提交）
   - 前端会把 token 保存到浏览器 `localStorage`，key 为 `cursor_remote_token`
   - 登录时会调用：`GET /api/auth/check?token=...` 进行校验
   - 校验通过后：
     - 调 `/api/*` 时使用请求头：`Authorization: Bearer <token>`
     - 建立 Socket.IO 连接时把 token 同时放在 `auth` 和 `query` 中（兜底）

3. 后端校验逻辑（怎么比对）
   - 后端从请求中提取 token，然后检查是否等于后端的 `AUTH_TOKEN`
   - 支持的提取方式包括：
     - `Authorization: Bearer <token>`
     - `X-Auth-Token: <token>`
     - `GET ...?token=<token>`
   - 只有 `/api/auth/check` 会被放行，其它 `/api/*` 默认需要鉴权

建议生产/团队使用时明确设置 `CURSOR_REMOTE_TOKEN`，避免每次重启 token 变化导致前端无法登录。

## 技术栈

- 前端：React 19 + TypeScript + Vite + Tailwind CSS 4 + Socket.IO Client + react-markdown（remark-gfm）+ react-syntax-highlighter（Prism）
- 后端：Python 3 + Flask + Flask-SocketIO（eventlet）
- 会话存储：SQLite（`session_store`）
- 执行层：Cursor Agent CLI（`AGENT_BIN`，默认如 `/root/.local/bin/agent`）

## REST / Socket 速查

- **HTTP**：`/api/health`、`/api/auth/check`、`/api/projects`、`/api/projects/<name>`、`/api/projects/default/<name>`、`/api/sessions`、`/api/sessions/<id>`（GET/PATCH/DELETE）
- **Socket.IO**：`execute`（payload 含会话、工作区、模型、用户输入等）、`kill`（终止指定会话任务）

更细的接口与事件字段见 `backend/app.py` 与 `frontend/src/App.tsx`。
