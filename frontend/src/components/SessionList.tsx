import { useState } from 'react'
import { Pencil, Square, Trash2 } from 'lucide-react'
import type { Session } from '../App'

interface Props {
  sessions: Session[]
  currentSessionId: string | null
  onSelect: (session: Session) => void
  onKill: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => void
}

export default function SessionList({ sessions, currentSessionId, onSelect, onKill, onDelete, onRename }: Props) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const startRename = (session: Session) => {
    setEditingSessionId(session.id)
    setDraftName(session.name || '新会话')
  }

  const cancelRename = () => {
    setEditingSessionId(null)
    setDraftName('')
  }

  const saveRename = (session: Session) => {
    const trimmed = draftName.trim()
    if (!trimmed) {
      cancelRename()
      return
    }
    onRename(session.id, trimmed)
    cancelRename()
  }

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#858585] text-xs p-4 text-center">
        暂无会话记录
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId
        const isRunning = session.is_running
        const isEditing = editingSessionId === session.id

        return (
          <div
            key={session.id}
            onClick={() => onSelect(session)}
            onContextMenu={(e) => {
              e.preventDefault()
              startRename(session)
            }}
            className={`
              group px-3 py-2 cursor-pointer border-b border-[#2d2d2d] transition-colors
              ${isActive ? 'bg-[#094771]' : 'hover:bg-[#2a2d2e]'}
            `}
          >
            <div className="flex items-center justify-between gap-2">
              {isEditing ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => saveRename(session)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') saveRename(session)
                    if (e.key === 'Escape') cancelRename()
                  }}
                  className="text-sm text-[#d4d4d4] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-1 py-0.5 flex-1 outline-none"
                  maxLength={20}
                />
              ) : (
                <span className="text-sm text-[#d4d4d4] truncate flex-1">
                  {session.name || '新会话'}
                </span>
              )}
              {isRunning && (
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 animate-pulse" />
              )}
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-[#858585] truncate max-w-[120px]">
                {session.workspace.split('/').pop() || session.workspace}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(session)
                  }}
                  className="p-1 rounded hover:bg-[#3c3c3c] text-[#858585]"
                  title="重命名"
                >
                  <Pencil size={10} />
                </button>
                {isRunning && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onKill(session.id)
                    }}
                    className="p-1 rounded hover:bg-red-700/50 text-red-400"
                    title="终止"
                  >
                    <Square size={10} />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(session.id)
                  }}
                  className="p-1 rounded hover:bg-red-700/50 text-red-400"
                  title="删除会话"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
