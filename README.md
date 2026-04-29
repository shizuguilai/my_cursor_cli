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

访问 http://localhost:5173

### 构建前端

```bash
cd frontend
npm run build
# 产物自动复制到 backend/static/
```

## 功能

- ✅ 多工作区管理（projects.json）
- ✅ 实时流式输出（thinking / tool_call / responding）
- ✅ 会话管理（新建 / 恢复 / 终止）
- ✅ WebSocket 双向通信
- ✅ 深色主题（Cursor IDE 风格）

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

- 前端：React 18 + TypeScript + Vite + TailwindCSS + Socket.IO Client
- 后端：Python 3.12 + Flask + Flask-SocketIO
- 执行层：Cursor Agent CLI (`/root/.local/bin/agent`)
