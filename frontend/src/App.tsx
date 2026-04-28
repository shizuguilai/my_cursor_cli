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
  type: 'thinking' | 'tool_call' | 'responding'
  content: string
  snippet: string
  elapsed: number
  timestamp: number
}

export interface SessionDetail extends Session {
  messages: OutputMessage[]
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [currentProject, setCurrentProject] = useState<Project | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSession, setCurrentSession] = useState<SessionDetail | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [connected, setConnected] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const socket = getSocket()

  // 加载工作区
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      const data = await res.json()
      setProjects(data.projects)
      if (data.projects.length > 0 && !currentProject) {
        setCurrentProject(data.projects[0])
      }
    } catch (e) {
      console.error('加载工作区失败:', e)
    }
  }, [currentProject])

  // 加载会话列表
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions')
      const data = await res.json()
      setSessions(data.sessions)
    } catch (e) {
      console.error('加载会话失败:', e)
    }
  }, [])

  // 添加新会话
  const addProject = async (name: string, path: string, description: string) => {
    try {
      const res = await fetch('/api/projects', {
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
      await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await loadProjects()
    } catch (e) {
      console.error('删除工作区失败:', e)
    }
  }

  // 选择会话
  const selectSession = useCallback((session: Session) => {
    setCurrentSession({
      ...session,
      messages: [],
    })
  }, [])

  // 发送消息
  const sendMessage = useCallback((prompt: string) => {
    if (!currentProject) return
    socket.emit('execute', {
      workspace: currentProject.path,
      prompt,
    })
  }, [currentProject, socket])

  // 终止任务
  const killSession = useCallback((sessionId: string) => {
    socket.emit('kill', { session_id: sessionId })
  }, [socket])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // 初始化
  useEffect(() => {
    loadProjects()
    loadSessions()

    // 连接状态
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    // 会话列表更新
    socket.on('sessions_update', (data: { sessions: Session[] }) => {
      setSessions(data.sessions)
    })

    // 开始执行
    socket.on('started', (data: { session_id: string }) => {
      loadSessions()
      // 找到新创建的会话并选中
      setTimeout(() => {
        const newSession = sessions.find(s => s.id === data.session_id) || {
          id: data.session_id,
          workspace: currentProject?.path || '',
          model: '',
          created_at: new Date().toISOString(),
          is_running: true,
        }
        selectSession(newSession)
      }, 500)
    })

    // 流式输出
    socket.on('output', (data: { session_id: string; type: string; content: string; snippet: string; elapsed: number }) => {
      setCurrentSession(prev => {
        if (!prev || prev.id !== data.session_id) return prev
        const newMsg: OutputMessage = {
          id: `${data.session_id}-${Date.now()}`,
          session_id: data.session_id,
          type: data.type as 'thinking' | 'tool_call' | 'responding',
          content: data.content,
          snippet: data.snippet,
          elapsed: data.elapsed,
          timestamp: Date.now(),
        }
        return { ...prev, messages: [...prev.messages, newMsg] }
      })
      setTimeout(scrollToBottom, 50)
    })

    // 执行完成
    socket.on('done', (data: { session_id: string; result: string; tool_summary: string[] }) => {
      setCurrentSession(prev => {
        if (!prev || prev.id !== data.session_id) return prev
        return {
          ...prev,
          is_running: false,
          result: data.result,
          messages: [
            ...prev.messages,
            {
              id: `${data.session_id}-done`,
              session_id: data.session_id,
              type: 'responding',
              content: `[完成] ${data.result?.slice(0, 200)}...`,
              snippet: data.result?.slice(0, 200) || '',
              elapsed: 0,
              timestamp: Date.now(),
            }
          ],
        }
      })
      loadSessions()
      setTimeout(scrollToBottom, 100)
    })

    // 错误
    socket.on('error', (data: { session_id: string; error: string }) => {
      setCurrentSession(prev => {
        if (!prev || prev.id !== data.session_id) return prev
        return {
          ...prev,
          is_running: false,
          error: data.error,
        }
      })
      loadSessions()
    })

    // 被终止
    socket.on('killed', (data: { session_id: string }) => {
      setCurrentSession(prev => {
        if (!prev || prev.id !== data.session_id) return prev
        return { ...prev, is_running: false }
      })
      loadSessions()
    })

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('sessions_update')
      socket.off('started')
      socket.off('output')
      socket.off('done')
      socket.off('error')
      socket.off('killed')
    }
  }, [loadProjects, loadSessions, selectSession, scrollToBottom, currentProject, sessions])

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
