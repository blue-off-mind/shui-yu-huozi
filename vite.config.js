import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 800 }, // three.js 本身约 600 KB
})
