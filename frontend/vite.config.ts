import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 生产构建直接写入 Flask 静态目录，避免再手动 cp dist */
const backendStaticDir = path.resolve(__dirname, '../backend/static')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: backendStaticDir,
    // outDir 在 frontend 根目录之外，必须显式允许清空，否则会保留旧 hash 的 js/css
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        // WebSocket 握手可能受 Host/Origin 影响；改写来源可提升兼容性
        changeOrigin: true,
      },
    },
  },
})
