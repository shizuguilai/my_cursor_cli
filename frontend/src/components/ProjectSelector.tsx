import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Trash2, FolderOpen } from 'lucide-react'
import type { Project } from '../App'

interface Props {
  projects: Project[]
  currentProject: Project | null
  onSelect: (project: Project) => void
  onAdd: (name: string, path: string, description: string) => void
  onDelete: (name: string) => void
}

export default function ProjectSelector({ projects, currentProject, onSelect, onAdd, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowAdd(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleAdd = () => {
    if (newName.trim() && newPath.trim()) {
      onAdd(newName.trim(), newPath.trim(), newDesc.trim())
      setNewName('')
      setNewPath('')
      setNewDesc('')
      setShowAdd(false)
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* 触发按钮 */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#3c3c3c] hover:bg-[#505050] text-sm text-[#d4d4d4] transition-colors"
      >
        <FolderOpen size={14} className="text-[#4ec9b0]" />
        <span className="max-w-[200px] truncate">
          {currentProject?.name || '选择工作区'}
        </span>
        <ChevronDown size={12} className={`text-[#858585] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-[#2d2d2d] border border-[#3c3c3c] rounded shadow-xl z-50">
          {/* 项目列表 */}
          <div className="max-h-64 overflow-y-auto">
            {projects.map((p) => (
              <div
                key={p.name}
                className={`
                  flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[#3c3c3c]
                  ${currentProject?.name === p.name ? 'bg-[#094771]' : ''}
                `}
                onClick={() => {
                  onSelect(p)
                  setOpen(false)
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{p.name}</div>
                  <div className={`text-xs truncate ${p.exists ? 'text-[#858585]' : 'text-red-400'}`}>
                    {p.path}
                    {!p.exists && ' ⚠️ 路径不存在'}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`删除工作区 "${p.name}"？`)) {
                      onDelete(p.name)
                    }
                  }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-700/50 text-red-400"
                  style={{ opacity: undefined }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          {/* 添加新项目 */}
          <div className="border-t border-[#3c3c3c] p-3">
            {showAdd ? (
              <div className="space-y-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="项目名称"
                  className="w-full bg-[#3c3c3c] text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#007acc] placeholder-[#858585]"
                  autoFocus
                />
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="工作区路径（绝对路径）"
                  className="w-full bg-[#3c3c3c] text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#007acc] placeholder-[#858585]"
                />
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="描述（可选）"
                  className="w-full bg-[#3c3c3c] text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#007acc] placeholder-[#858585]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAdd}
                    className="flex-1 py-1.5 rounded bg-[#0e639c] hover:bg-[#1177bb] text-white text-sm transition-colors"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => setShowAdd(false)}
                    className="flex-1 py-1.5 rounded bg-[#3c3c3c] hover:bg-[#505050] text-white text-sm transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAdd(true)}
                className="w-full flex items-center justify-center gap-1 py-1.5 rounded bg-[#0e639c]/50 hover:bg-[#0e639c] text-white text-sm transition-colors"
              >
                <Plus size={14} />
                添加工作区
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
