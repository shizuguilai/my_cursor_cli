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
  // 仅在显式传入 token 时更新认证，避免无 token 调用污染当前连接状态
  const nextToken = typeof token === 'string' ? token : currentToken
  if (!nextToken) {
    throw new Error('[Socket] getSocket() requires token on first initialization')
  }

  console.log('[Socket] getSocket(): nextToken =', nextToken)
  if (!socket || currentToken !== nextToken) {
    disconnectIfNeeded()
    currentToken = nextToken

    socket = io({
      path: '/socket.io',
      autoConnect: false,
      transports: ['polling', 'websocket'],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      // 仅使用标准 auth，避免 query/auth 双通道导致后端 auth_keys 抖动
      auth: { token: nextToken, authorization: nextToken },
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
