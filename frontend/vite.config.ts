import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(() => {
  const API_URL = process.env.VITE_API_URL || 'http://localhost:8000'
  const PLATFORM = process.env.VITE_APP_PLATFORM || 'electron'

  return {
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: parseInt(process.env.VITE_PORT || '5173', 10),
    },
    define: {
      __API_URL__: JSON.stringify(API_URL),
      __PLATFORM__: JSON.stringify(PLATFORM),
    },
  }
})
