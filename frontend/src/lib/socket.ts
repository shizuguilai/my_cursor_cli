import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null
let currentToken: string | null = null

function disconnectIfNeeded() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}

export function getSocket(token?: string): Socket {
  // token 变化时重建连接，避免沿用旧认证信息
  const nextToken = token ? token : null
  if (!socket || currentToken !== nextToken) {
    disconnectIfNeeded()
    currentToken = nextToken

    socket = io({
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      auth: nextToken ? { token: nextToken } : undefined,
    })

    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket?.id)
    })

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason)
    })

    socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message)
    })
  }
  return socket
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
  currentToken = null
}
