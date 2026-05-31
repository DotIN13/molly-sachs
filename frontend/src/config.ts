declare const __API_URL__: string
declare const __PLATFORM__: string

export const API_URL: string = typeof __API_URL__ !== 'undefined' ? __API_URL__ : 'http://localhost:8000'

export const PLATFORM: string = typeof __PLATFORM__ !== 'undefined' ? __PLATFORM__ : 'electron'

export const isElectron: boolean = PLATFORM === 'electron'
export const isWeb: boolean = PLATFORM === 'web'

const TOKEN_KEY = 'molly_access_token'
const REFRESH_KEY = 'molly_refresh_token'

export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function getStoredRefresh(): string | null {
  try { return localStorage.getItem(REFRESH_KEY) } catch { return null }
}

export function storeTokens(access: string, refresh: string) {
  try {
    localStorage.setItem(TOKEN_KEY, access)
    localStorage.setItem(REFRESH_KEY, refresh)
  } catch { /* noop */ }
}

export function clearTokens() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
  } catch { /* noop */ }
}

export async function refreshAccessToken(): Promise<string | null> {
  const rToken = getStoredRefresh()
  if (!rToken) return null
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rToken }),
    })
    if (res.ok) {
      const data = await res.json()
      try { localStorage.setItem(TOKEN_KEY, data.access_token) } catch { /* noop */ }
      return data.access_token
    }
  } catch { /* offline */ }
  return null
}
