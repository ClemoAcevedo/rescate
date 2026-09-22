import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const certificateFile = process.env.DEV_TLS_CERT_FILE
const keyFile = process.env.DEV_TLS_KEY_FILE
const https = certificateFile && keyFile
  ? { cert: readFileSync(certificateFile), key: readFileSync(keyFile) }
  : undefined

export default defineConfig({
  plugins: [react()],
  server: {
    https,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
