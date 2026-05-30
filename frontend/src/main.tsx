import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isWeb } from './config'
import './index.css'
import App from './App.tsx'

if (isWeb && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
