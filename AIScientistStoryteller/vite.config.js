// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // FastAPI
      '/api/explain':    { target: (process.env.VITE_BACKEND_URL || 'http://localhost:8000'), changeOrigin: true },
      '/api/qwen_infer': { target: (process.env.VITE_BACKEND_URL || 'http://localhost:8000'), changeOrigin: true },

      // Next.js (solo API di auth/me/proxy PDF, NIENTE /login)
      '/api/auth': { target: (process.env.VITE_AUTH_URL || 'http://localhost:3000'), changeOrigin: true },
      '/api/me':   { target: (process.env.VITE_AUTH_URL || 'http://localhost:3000'), changeOrigin: true },

      // catch-all API → Next (tienila in fondo)
      '/api': { target: (process.env.VITE_AUTH_URL || 'http://localhost:3000'), changeOrigin: true },

      // opzionale
      '/llm': {
        target: (process.env.VITE_BACKEND_URL || 'http://localhost:8000'),
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm/, '/api'),
      },
    }
  }
})
