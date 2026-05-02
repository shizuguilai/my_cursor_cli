import { useState, useRef, type KeyboardEvent, type RefObject } from 'react'
import { Send, Square, Loader2 } from 'lucide-react'
import type { SessionDetail } from '../App'

interface Props {
  session: SessionDetail | null
  onSend: (prompt: string) => void
  onKill: (sessionId: string) => void
  messagesEndRef: RefObject<HTMLDivElement | null>
}

export default function ChatPanel({ session, onSend, onKill, messagesEndRef }: Props) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    onSend(text)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#858585] text-sm">
        <div className="text-center">
          <p className="mb-2">选择一个会话或在左侧新建会话</p>
          <p className="text-xs opacity-60">输入消息开始与 Cursor Agent 对话</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {session.messages.length === 0 && !session.is_running && (
          <div className="text-center text-[#858585] text-sm mt-20">
            <p className="mb-1">会话已就绪</p>
            <p className="text-xs opacity-60">在下方输入消息开始执行任务</p>
          </div>
        )}

        {session.messages.map((msg, idx) => {
          const isLast = idx === session.messages.length - 1
          const isStreaming = !!session.is_running && isLast && msg.type === 'responding'
          return <MessageBubble key={msg.id} message={msg} isStreaming={isStreaming} />
        })}

        {session.error && (
          <div className="rounded p-3 bg-red-900/30 border border-red-800 text-red-300 text-sm font-mono">
            错误: {session.error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="p-4 border-t border-[#3c3c3c] bg-[#1e1e1e]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            disabled={session.is_running}
            rows={1}
            className="flex-1 bg-[#3c3c3c] text-white text-sm rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[#007acc] disabled:opacity-50 placeholder-[#858585] min-h-[44px] max-h-[200px]"
            style={{ height: 'auto', overflow: 'hidden' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = 'auto'
              target.style.height = Math.min(target.scrollHeight, 200) + 'px'
            }}
          />
          
          {session.is_running ? (
            <button
              onClick={() => onKill(session.id)}
              className="p-2.5 rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
              title="终止任务"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-2.5 rounded bg-[#007acc] hover:bg-[#005a9e] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="发送"
            >
              <Send size={16} />
            </button>
          )}
        </div>

        {/* Session info */}
        <div className="mt-2 flex items-center gap-3 text-xs text-[#858585]">
          {session.is_running && (
            <span className="flex items-center gap-1 text-[#4ec9b0]">
              <Loader2 size={10} className="animate-spin" />
              执行中
            </span>
          )}
          <span>工作区: {session.workspace}</span>
          <span>会话: {session.id}</span>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ message, isStreaming }: { message: SessionDetail['messages'][0]; isStreaming: boolean }) {
  const typeStyles: Record<string, string> = {
    user: 'border-l-2 border-[#5b9bd5] bg-[#2d2d30]',
    thinking: 'border-l-2 border-yellow-600 bg-yellow-900/10',
    tool_call: 'border-l-2 border-blue-600 bg-blue-900/10',
    responding: 'border-l-2 border-green-600 bg-transparent',
  }

  const typeLabels: Record<string, string> = {
    user: '🧑 你',
    thinking: '🤔 思考中',
    tool_call: '🔧 工具调用',
    responding: '💬 回复',
  }

  const typeColors: Record<string, string> = {
    user: 'text-[#9cdcfe]',
    thinking: 'text-yellow-400',
    tool_call: 'text-blue-400',
    responding: 'text-green-400',
  }

  const hasContent = !!message.content
  const displayContent = hasContent ? message.content : (message.snippet || (isStreaming ? '' : '...'))

  return (
    <div className={`rounded p-3 ${typeStyles[message.type] || ''}`} data-message-id={message.id}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs font-medium ${typeColors[message.type] || 'text-white'}`}>
          {typeLabels[message.type] || '消息'}
        </span>
        {message.elapsed > 0 && (
          <span className="text-xs text-[#858585]">{formatElapsed(message.elapsed)}</span>
        )}
      </div>
      <div
        className="text-sm text-[#d4d4d4] font-mono whitespace-pre-wrap break-words"
        data-message-content-id={message.id}
      >
        {displayContent}
        {isStreaming && (
          <span className="inline-block w-[7px] h-[1em] ml-0.5 align-text-bottom bg-green-400 animate-pulse" aria-hidden />
        )}
      </div>
    </div>
  )
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}
