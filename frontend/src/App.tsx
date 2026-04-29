import { useState, useEffect, useCallback, useRef } from 'react'
import { getSocket } from './lib/socket'
import SessionList from './components/SessionList'
import ChatPanel from './components/ChatPanel'
import ProjectSelector from './components/ProjectSelector'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

export interface Session {
  id: string
  workspace: string
  model: string
  created_at: string
  is_running: boolean
  result?: string
  error?: string
}

export interface Project {
  name: string
  path: string
  description: string
  exists: boolean
}

export interface OutputMessage {
  id: string
  session_id: string
  type: 'thinking' | 'tool_call' | 'responding' | 'user'
  content: string
  snippet: string
  elapsed: number
  timestamp: number
}

export interface SessionDetail extends Session {
  messages: OutputMessage[]
}

// 气泡状态（供 ChatPanel 内部使用）
export interface BubbleState {
  activeBubble: OutputMessage | null
  completedBubbles: OutputMessage[]
}

function App() {
  const TOKEN_STORAGE_KEY = 'cursor_remote_token'

  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authToken, setAuthToken] = useState<string>('')
  const [authChecking, setAuthChecking] = useState(true)
  const [loginToken, setLoginToken] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)

  const [projects, setProjects] = useState<Project[]>([])
  const [currentProject, setCurrentProject] = useState<Project | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSession, setCurrentSession] = useState<SessionDetail | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [connected, setConnected] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const socketRef = useRef<any>(null)
  const pendingRequestSentAtRef = useRef<Record<string, number>>({})
  const firstOutputSeenRef = useRef<Record<string, boolean>>({})

  const authedFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {})
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
    return fetch(url, { ...options, headers })
  }, [authToken])

  // 加载工作区
  const loadProjects = useCallback(async () => {
    try {
      const res = await authedFetch('/api/projects')
      const data = await res.json()
      setProjects(data.projects)
      setCurrentProject(prev => {
        if (prev) return prev
        return data.projects.length > 0 ? data.projects[0] : null
      })
    } catch (e) {
      console.error('加载工作区失败:', e)
    }
  }, [authedFetch])

  // 加载会话列表
  const loadSessions = useCallback(async () => {
    try {
      const res = await authedFetch('/api/sessions')
      const data = await res.json()
      setSessions(data.sessions)
    } catch (e) {
      console.error('加载会话失败:', e)
    }
  }, [authedFetch])

  // 添加新会话
  const addProject = async (name: string, path: string, description: string) => {
    try {
      const res = await authedFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path, description }),
      })
      if (res.ok) {
        await loadProjects()
      }
    } catch (e) {
      console.error('添加工作区失败:', e)
    }
  }

  // 删除工作区
  const deleteProject = async (name: string) => {
    try {
      await authedFetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await loadProjects()
    } catch (e) {
      console.error('删除工作区失败:', e)
    }
  }

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  // 选择会话（从后端加载完整历史）
  const selectSession = useCallback(async (session: Session) => {
    if (session.id.startsWith('new-')) {
      setCurrentSession({
        ...session,
        messages: [],
      })
      scrollToBottom()
      return
    }

    try {
      const res = await authedFetch(`/api/sessions/${encodeURIComponent(session.id)}`)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const detail = await res.json()
      setCurrentSession({
        ...session,
        ...detail,
        messages: detail.messages || [],
      })
      scrollToBottom()
    } catch (e) {
      console.error('加载会话详情失败:', e)
      setCurrentSession({
        ...session,
        messages: [],
      })
      scrollToBottom()
    }
  }, [authedFetch, scrollToBottom])

  // 发送消息
  const sendMessage = useCallback((prompt: string) => {
    if (!currentProject) {
      console.warn('[Socket] Cannot send: no project selected')
      return
    }
    const socket = socketRef.current
    if (!socket || !socket.connected) {
      console.warn('[Socket] Cannot send: socket not connected')
      return
    }
    // 1. 先把用户消息加入气泡显示
    const userMsg: OutputMessage = {
      id: `user-${Date.now()}`,
      session_id: currentSession?.id || '',
      type: 'user',
      content: prompt,
      snippet: prompt.slice(0, 50),
      elapsed: 0,
      timestamp: Date.now(),
    }
    setCurrentSession(prev => prev ? { ...prev, messages: [...prev.messages, userMsg] } : prev)

    const clientSentAt = Date.now()
    const requestId = `req-${clientSentAt}-${Math.random().toString(36).slice(2, 8)}`
    pendingRequestSentAtRef.current[requestId] = clientSentAt
    firstOutputSeenRef.current[requestId] = false
    console.log(
      `[sendMessage][client] request_id=${requestId} session_id=${currentSession?.id || 'new'} ` +
      `prompt_len=${prompt.length} sent_at=${clientSentAt}`
    )

    // 2. 发送时带上 session_id，让后端复用已有会话
    socket.emit('execute', {
      workspace: currentProject.path,
      prompt,
      session_id: currentSession?.id && !currentSession.id.startsWith('new-') ? currentSession.id : undefined,
      request_id: requestId,
      client_sent_at: clientSentAt,
    })
    scrollToBottom()
  }, [currentProject, currentSession, scrollToBottom])

  // 终止任务
  const killSession = useCallback((sessionId: string) => {
    const socket = socketRef.current
    socket?.emit('kill', { session_id: sessionId })
  }, [])

  // 删除会话
  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const res = await authedFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      setCurrentSession((prev) => (prev?.id === sessionId ? null : prev))
      await loadSessions()
    } catch (e) {
      console.error('删除会话失败:', e)
    }
  }, [loadSessions, authedFetch])

  // 首次启动：读取本地 token 并校验
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (!stored) {
      setAuthChecking(false)
      return
    }

    ;(async () => {
      try {
        const res = await fetch(`/api/auth/check?token=${encodeURIComponent(stored)}`)
        if (res.ok) {
          setAuthToken(stored)
          setIsAuthenticated(true)
        } else {
          localStorage.removeItem(TOKEN_STORAGE_KEY)
        }
      } catch (e) {
        console.error('token 校验失败:', e)
      } finally {
        setAuthChecking(false)
      }
    })()
  }, [])

  const handleLogin = useCallback(async () => {
    setLoginError(null)
    const token = loginToken.trim()
    if (!token) {
      setLoginError('请输入 token')
      return
    }

    try {
      const res = await fetch(`/api/auth/check?token=${encodeURIComponent(token)}`)
      if (res.ok) {
        localStorage.setItem(TOKEN_STORAGE_KEY, token)
        setAuthToken(token)
        setIsAuthenticated(true)
      } else {
        setLoginError('token 无效')
      }
    } catch (e) {
      console.error('登录失败:', e)
      setLoginError('登录失败')
    }
  }, [loginToken])

  // 初始化数据（鉴权通过后）
  useEffect(() => {
    if (!isAuthenticated || !authToken) return

    loadProjects()
    loadSessions()
  }, [isAuthenticated, authToken, loadProjects, loadSessions])

  // 初始化 socket（鉴权通过后）
  useEffect(() => {
    if (!isAuthenticated || !authToken) return

    console.log('[Socket] getSocket called with authToken:', authToken)
    const socket = getSocket(authToken)
    socketRef.current = socket

    // 连接状态
    setConnected(socket.connected)
    socket.on('connect', () => {
      console.log('[Socket] App socket.on(connect) -> setConnected(true)')
      setConnected(true)
    })
    socket.on('disconnect', (reason) => {
      console.log('[Socket] App socket.on(disconnect) -> setConnected(false):', reason)
      setConnected(false)
    })
    socket.on('connect_error', (err) => {
      console.error('[Socket] App socket.on(connect_error) -> setConnected(false):', err?.message || err)
      setConnected(false)
    })

    // 监听器注册完成后再 connect，避免错过首个 connect 事件
    if (!socket.connected) {
      socket.connect()
    }

    // 会话列表更新
    socket.on('sessions_update', (data: { sessions: Session[] }) => {
      setSessions(data.sessions)
    })

    // 开始执行 → 立即用真实 session_id 更新 currentSession
    socket.on('started', (data: { session_id: string; request_id?: string; client_sent_at?: number; server_received_at?: number; server_started_emit_at?: number }) => {
      const realSessionId = data.session_id
      const now = Date.now()
      if (data.request_id) {
        const localSentAt = pendingRequestSentAtRef.current[data.request_id] ?? data.client_sent_at
        const totalStartLatency = typeof localSentAt === 'number' ? now - localSentAt : -1
        const clientToServer = (typeof data.server_received_at === 'number' && typeof localSentAt === 'number')
          ? data.server_received_at - localSentAt
          : -1
        const serverQueue = (typeof data.server_started_emit_at === 'number' && typeof data.server_received_at === 'number')
          ? data.server_started_emit_at - data.server_received_at
          : -1
        console.log(
          `[sendMessage][timing] started request_id=${data.request_id} session_id=${realSessionId} ` +
          `total_start_ms=${totalStartLatency} client_to_server_ms=${clientToServer} server_queue_ms=${serverQueue}`
        )
      }
      setCurrentSession(prev => {
        if (!prev) return prev
        // 只在“当前会话”确实对应这次 started 时更新 is_running
        if (!prev.id.startsWith('new-') && prev.id !== realSessionId) return prev

        // 如果 currentSession 没有有效 id（new-开头），用真实 id 替换
        const finalId = prev.id.startsWith('new-') ? realSessionId : prev.id
        return { ...prev, id: finalId, is_running: true }
      })
      setSessions(prev => prev.map(s => {
        if (s.id.startsWith('new-')) return { ...s, id: realSessionId }
        return s
      }))
      loadSessions()
    })

    // 流式输出
    socket.on('output', (data: { session_id: string; type: string; content: string; snippet: string; elapsed: number; request_id?: string }) => {
      if (!data.content) return
      if (data.request_id) {
        const seen = firstOutputSeenRef.current[data.request_id]
        if (!seen) {
          firstOutputSeenRef.current[data.request_id] = true
          const localSentAt = pendingRequestSentAtRef.current[data.request_id]
          if (typeof localSentAt === 'number') {
            console.log(
              `[sendMessage][timing] first_output request_id=${data.request_id} ` +
              `session_id=${data.session_id} first_output_ms=${Date.now() - localSentAt} output_type=${data.type}`
            )
          }
        }
      }
      setCurrentSession(prev => {
        if (!prev) return prev
        // 如果 currentSession 是 new- 开头但 output 带来了真实 id，同步更新
        const targetId = prev.id.startsWith('new-') ? data.session_id : prev.id
        if (targetId !== prev.id) return { ...prev, id: targetId }
        if (prev.id !== data.session_id) return prev
        const now = Date.now()
        const existingActive = prev.messages.length > 0 ? prev.messages[prev.messages.length - 1] : null
        const canMerge = existingActive && existingActive.type === data.type && prev.is_running && existingActive.id && !existingActive.id.startsWith('user-')
        if (canMerge) {
          const updated = [...prev.messages]
          updated[updated.length - 1] = { ...updated[updated.length - 1], content: data.content, snippet: data.snippet, elapsed: data.elapsed, timestamp: now }
          return { ...prev, messages: updated }
        } else {
          const newMsg: OutputMessage = { id: `${data.session_id}-${now}`, session_id: data.session_id, type: data.type as any, content: data.content, snippet: data.snippet, elapsed: data.elapsed, timestamp: now }
          return { ...prev, messages: [...prev.messages, newMsg] }
        }
      })
      scrollToBottom()
    })

    // 执行完成
    socket.on('done', (data: { session_id: string; result: string; tool_summary: string[]; request_id?: string }) => {
      if (data.request_id) {
        const localSentAt = pendingRequestSentAtRef.current[data.request_id]
        if (typeof localSentAt === 'number') {
          console.log(
            `[sendMessage][timing] done request_id=${data.request_id} ` +
            `session_id=${data.session_id} total_ms=${Date.now() - localSentAt}`
          )
        }
        delete pendingRequestSentAtRef.current[data.request_id]
        delete firstOutputSeenRef.current[data.request_id]
      }
      setCurrentSession(prev => {
        if (!prev) return prev
        if (prev.id !== data.session_id) return prev
        return { ...prev, is_running: false, result: data.result }
      })
      loadSessions()
      scrollToBottom()
    })

    // 错误
    socket.on('error', (data: { session_id: string; error: string }) => {
      setCurrentSession(prev => {
        if (!prev) return prev
        if (prev.id !== data.session_id) return prev
        return { ...prev, is_running: false, error: data.error }
      })
      loadSessions()
    })

    // 被终止
    socket.on('killed', (data: { session_id: string }) => {
      setCurrentSession(prev => {
        if (!prev) return prev
        if (prev.id !== data.session_id) return prev
        return { ...prev, is_running: false }
      })
      loadSessions()
    })

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('connect_error')
      socket.off('sessions_update')
      socket.off('started')
      socket.off('output')
      socket.off('done')
      socket.off('error')
      socket.off('killed')
      // 只卸载监听器，不主动断开全局 socket，避免短暂重渲染导致“连接后立即断开”
    }
  }, [isAuthenticated, authToken, scrollToBottom, loadSessions])

  if (authChecking) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e] text-white font-mono px-4">
        <div className="text-sm text-[#858585]">Token 校验中...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e] text-white font-mono px-4">
        <div className="w-full max-w-md bg-[#252526] border border-[#3c3c3c] rounded-lg p-6">
          <h1 className="text-base font-semibold text-[#cccccc] mb-4">Cursor 远程控制台 - Token 登录</h1>
          <div className="text-xs text-[#858585] uppercase tracking-wider mb-2">Token</div>
          <input
            type="password"
            value={loginToken}
            onChange={(e) => setLoginToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleLogin()
            }}
            className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm outline-none focus:border-[#5b9bd5]"
            placeholder="输入访问 token"
          />
          {loginError && <div className="mt-2 text-xs text-red-400">{loginError}</div>}
          <button
            onClick={() => handleLogin()}
            className="mt-4 w-full bg-[#5b9bd5] hover:bg-[#4f8fca] text-[#0b0b0b] font-semibold rounded px-3 py-2"
          >
            进入主界面
          </button>
          <div className="mt-3 text-xs text-[#858585]">
            登录后 token 会保存在 `localStorage`，刷新无需重复登录。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-[#1e1e1e] text-white font-mono">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-[#252526] border-b border-[#3c3c3c]">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold text-[#cccccc]">Cursor 远程控制台</h1>
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} title={connected ? '已连接' : '未连接'} />
        </div>
        <div className="flex items-center gap-2">
          <ProjectSelector
            projects={projects}
            currentProject={currentProject}
            onSelect={setCurrentProject}
            onAdd={addProject}
            onDelete={deleteProject}
          />
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="w-6 bg-[#252526] border-r border-[#3c3c3c] flex items-center justify-center hover:bg-[#2a2d2e] text-[#858585]"
        >
          {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Session sidebar */}
        {sidebarOpen && (
          <aside className="w-64 bg-[#252526] border-r border-[#3c3c3c] flex flex-col">
            <div className="p-3 border-b border-[#3c3c3c] flex items-center justify-between">
              <span className="text-xs text-[#858585] uppercase tracking-wider">会话列表</span>
              <button
                onClick={() => {
                  if (currentProject) {
                    const newSession: Session = {
                      id: `new-${Date.now()}`,
                      workspace: currentProject.path,
                      model: '',
                      created_at: new Date().toISOString(),
                      is_running: false,
                    }
                    selectSession(newSession)
                  }
                }}
                className="p-1 rounded hover:bg-[#3c3c3c] text-[#858585]"
                title="新建会话"
              >
                <Plus size={14} />
              </button>
            </div>
            <SessionList
              sessions={sessions}
              currentSessionId={currentSession?.id || null}
              onSelect={(s) => selectSession(s)}
              onKill={killSession}
              onDelete={deleteSession}
            />
          </aside>
        )}

        {/* Chat area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <ChatPanel
            session={currentSession}
            onSend={sendMessage}
            onKill={killSession}
            messagesEndRef={messagesEndRef}
          />
        </main>
      </div>
    </div>
  )
}

export default App
