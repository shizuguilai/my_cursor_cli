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
  name?: string
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
  /** execute 请求里 new-* 临时 id → 仅 started 时把「对应那条请求」的占位会话改成真实 id */
  const requestIdToTempSessionRef = useRef<Record<string, string>>({})
  /** 每条 request 归属的客户端会话 id（发送时的锚点；started 后 new-* 会改为真实 id），用于丢弃「非当前会话」的 socket 输出 */
  const requestIdToAnchorSessionRef = useRef<Record<string, string>>({})
  /** 当某 session 没有 request_id 时，用 session-level 兜底 messageId（用于 killed 等场景） */
  const sessionFallbackRespondingIdRef = useRef<Record<string, string>>({})
  const doneReceivedRef = useRef<Record<string, boolean>>({})


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
    const isNewSession = !currentSession || currentSession.id.startsWith('new-')
    let targetSessionId = currentSession?.id || ''
    /** 发送瞬间锚定的会话 id，用于 setState 时拒绝「已切到其他会话」的错位追加 */
    let anchorSessionId = !isNewSession && currentSession?.id && !currentSession.id.startsWith('new-')
      ? currentSession.id
      : ''

    if (isNewSession) {
      const tempSessionId = currentSession?.id?.startsWith('new-') ? currentSession.id : `new-${Date.now()}`
      anchorSessionId = tempSessionId
      const optimisticSession: Session = {
        id: tempSessionId,
        workspace: currentProject.path,
        model: '',
        name: '正在生成会话名称...',
        created_at: new Date().toISOString(),
        is_running: true,
      }
      targetSessionId = tempSessionId
      setSessions((prev) => {
        const filtered = prev.filter((s) => s.id !== tempSessionId)
        return [optimisticSession, ...filtered]
      })
      setCurrentSession({
        ...optimisticSession,
        messages: currentSession?.messages || [],
      })
    }

    // 1. 先把用户消息加入气泡显示
    const userMsg: OutputMessage = {
      id: `user-${Date.now()}`,
      session_id: targetSessionId,
      type: 'user',
      content: prompt,
      snippet: prompt.slice(0, 50),
      elapsed: 0,
      timestamp: Date.now(),
    }
    setCurrentSession((prev) => {
      if (!prev || prev.id !== anchorSessionId) return prev
      return { ...prev, messages: [...(prev.messages || []), userMsg] }
    })

    const clientSentAt = Date.now()
    const requestId = `req-${clientSentAt}-${Math.random().toString(36).slice(2, 8)}`
    if (isNewSession) {
      requestIdToTempSessionRef.current[requestId] = anchorSessionId
    }
    requestIdToAnchorSessionRef.current[requestId] = anchorSessionId
    pendingRequestSentAtRef.current[requestId] = clientSentAt
    firstOutputSeenRef.current[requestId] = false
    // Reset done flag so output events are processed for this request
    if (targetSessionId) doneReceivedRef.current[targetSessionId] = false
    console.log(
      `[sendMessage][client] request_id=${requestId} session_id=${targetSessionId || 'new'} ` +
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
    loadSessions()
    scrollToBottom()
  }, [currentProject, currentSession, loadSessions, scrollToBottom])

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

  const renameSession = useCallback(async (sessionId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return
    try {
      const res = await authedFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name: nextName } : s)))
      setCurrentSession((prev) => (prev?.id === sessionId ? { ...prev, name: nextName } : prev))
      await loadSessions()
    } catch (e) {
      console.error('重命名会话失败:', e)
    }
  }, [authedFetch, loadSessions])



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
      const reqId = data.request_id
      const tempForThisRequest = reqId ? requestIdToTempSessionRef.current[reqId] : undefined
      if (reqId) {
        delete requestIdToTempSessionRef.current[reqId]
      }
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
        doneReceivedRef.current[realSessionId] = false
        console.log(
          `[sendMessage][timing] started request_id=${data.request_id} session_id=${realSessionId} ` +
          `total_start_ms=${totalStartLatency} client_to_server_ms=${clientToServer} server_queue_ms=${serverQueue}`
        )
      }
      setCurrentSession(prev => {
        if (!prev) return prev
        if (!prev.id.startsWith('new-')) {
          if (prev.id !== realSessionId) return prev
          return { ...prev, is_running: true }
        }
        // new-*：仅当当前占位 id 就是发出此 request 的那条临时会话时才升级为真实 id（避免多 new- 标签被 started 串改）
        if (!tempForThisRequest || prev.id !== tempForThisRequest) return prev
        return { ...prev, id: realSessionId, is_running: true }
      })
      if (reqId && tempForThisRequest) {
        const a = requestIdToAnchorSessionRef.current[reqId]
        if (a === tempForThisRequest) {
          requestIdToAnchorSessionRef.current[reqId] = realSessionId
        }
      }
      if (tempForThisRequest) {
        setSessions(prev => prev.map((s) => (s.id === tempForThisRequest ? { ...s, id: realSessionId } : s)))
      }
      loadSessions()
    })

    // 流式输出
    socket.on('output', (data: { session_id: string; type: string; content: string; delta?: string; snippet: string; elapsed: number; request_id?: string }) => {
      const incomingText = data.delta ?? data.content
      if (!incomingText) return
      // done 之后不再处理 output，避免覆盖 done.result 的权威内容
      // done 之后不再处理任何 output，避免末尾空 content 创建重复气泡
      if (doneReceivedRef.current[data.session_id]) return
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
      if (data.type === 'responding') {
        const messageId = data.request_id
          ? `${data.request_id}-responding`
          : `${data.session_id}-responding`
        // 没有 request_id 时记录 session 级兜底 id（用于 killed/error 收尾）
        if (!data.request_id) {
          sessionFallbackRespondingIdRef.current[data.session_id] = messageId
        }
        setCurrentSession(prev => {
          if (!prev) return prev
          if (data.request_id) {
            const anchor = requestIdToAnchorSessionRef.current[data.request_id]
            if (anchor !== undefined && prev.id !== anchor) return prev
          } else if (prev.id !== data.session_id) {
            return prev
          }
          const existingIdx = prev.messages.findIndex((m) => m.id === messageId)
          const now = Date.now()
          const nextId = prev.id.startsWith('new-') ? data.session_id : prev.id
          if (existingIdx >= 0) {
            // 已有该 request 的气泡：直接把 delta 追加到末尾，复刻 LLM 吐字节奏
            const updated = [...prev.messages]
            const target = updated[existingIdx]
            updated[existingIdx] = {
              ...target,
              content: `${target.content}${incomingText}`,
              snippet: data.snippet || target.snippet,
              elapsed: data.elapsed,
            }
            return { ...prev, id: nextId, messages: updated }
          }
          // 首个 chunk：新建气泡，content 直接放 delta
          const newMsg: OutputMessage = {
            id: messageId,
            session_id: data.session_id,
            type: 'responding',
            content: incomingText,
            snippet: data.snippet || '',
            elapsed: data.elapsed,
            timestamp: now,
          }
          return { ...prev, id: nextId, messages: [...prev.messages, newMsg] }
        })
        scrollToBottom()
        return
      }
      // 非 responding（thinking / tool_call）：每条事件覆盖最后一个同类型气泡，避免气泡爆炸
      setCurrentSession(prev => {
        if (!prev) return prev
        if (data.request_id) {
          const anchor = requestIdToAnchorSessionRef.current[data.request_id]
          if (anchor !== undefined && prev.id !== anchor) return prev
        } else if (prev.id !== data.session_id) {
          return prev
        }
        const now = Date.now()
        const existingActive = prev.messages.length > 0 ? prev.messages[prev.messages.length - 1] : null
        const canMerge = existingActive && existingActive.type === data.type && existingActive.session_id === data.session_id
        if (canMerge) {
          const updated = [...prev.messages]
          const previous = updated[updated.length - 1]
          updated[updated.length - 1] = { ...previous, content: incomingText, snippet: data.snippet, elapsed: data.elapsed, timestamp: now }
          return { ...prev, messages: updated }
        }
        const newMsg: OutputMessage = {
          id: `${data.session_id}-${now}`,
          session_id: data.session_id,
          type: data.type as any,
          content: incomingText,
          snippet: data.snippet,
          elapsed: data.elapsed,
          timestamp: now,
        }
        return { ...prev, messages: [...prev.messages, newMsg] }
      })
      scrollToBottom()
    })

    // 执行完成
    socket.on('done', (data: { session_id: string; result: string; tool_summary: string[]; request_id?: string }) => {
      const anchorAtDone = data.request_id ? requestIdToAnchorSessionRef.current[data.request_id] : undefined
      doneReceivedRef.current[data.session_id] = true
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
        delete requestIdToAnchorSessionRef.current[data.request_id]
      }
      // done.result 是权威完整内容，覆盖到对应气泡，确保最终一致
      const messageId = data.request_id
        ? `${data.request_id}-responding`
        : sessionFallbackRespondingIdRef.current[data.session_id]
      console.log('[done] messageId', messageId, 'result_len', data.result.length, 'session_id', data.session_id)
      setCurrentSession(prev => {
        if (!prev) return prev
        const matches =
          prev.id === data.session_id ||
          (anchorAtDone !== undefined && prev.id === anchorAtDone)
        if (!matches) return prev
        const messages = messageId
          ? prev.messages.map(m =>
              m.id === messageId ? { ...m, content: data.result } : m
            )
          : prev.messages
        return { ...prev, is_running: false, result: data.result, messages }
      })
      delete sessionFallbackRespondingIdRef.current[data.session_id]
      loadSessions()
      scrollToBottom()
    })

    // 错误
    socket.on('error', (data: { session_id: string; error: string; request_id?: string }) => {
      const anchorAtErr = data.request_id ? requestIdToAnchorSessionRef.current[data.request_id] : undefined
      delete sessionFallbackRespondingIdRef.current[data.session_id]
      if (data.request_id) {
        delete requestIdToAnchorSessionRef.current[data.request_id]
      }
      setCurrentSession(prev => {
        if (!prev) return prev
        const matches =
          prev.id === data.session_id ||
          (anchorAtErr !== undefined && prev.id === anchorAtErr)
        if (!matches) return prev
        return { ...prev, is_running: false, error: data.error }
      })
      loadSessions()
    })

    // 被终止
    socket.on('killed', (data: { session_id: string }) => {
      delete sessionFallbackRespondingIdRef.current[data.session_id]
      for (const k of Object.keys(requestIdToAnchorSessionRef.current)) {
        if (requestIdToAnchorSessionRef.current[k] === data.session_id) {
          delete requestIdToAnchorSessionRef.current[k]
        }
      }
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
                      name: '新会话',
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
              onRename={renameSession}
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
