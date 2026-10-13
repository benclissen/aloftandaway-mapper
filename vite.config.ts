import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/studio',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/studio',
    emptyOutDir: true,
    // MapLibre alone is over 1 MB, and the studio is only ever loaded from localhost.
    chunkSizeWarningLimit: 2048,
  },
})
