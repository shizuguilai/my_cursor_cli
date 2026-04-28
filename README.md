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

```bash
cd backend
pip install -r requirements.txt
python3 app.py
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

## 技术栈

- 前端：React 18 + TypeScript + Vite + TailwindCSS + Socket.IO Client
- 后端：Python 3.12 + Flask + Flask-SocketIO
- 执行层：Cursor Agent CLI (`/root/.local/bin/agent`)
