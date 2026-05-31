import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import i18n from '../i18n/config'
import { API_URL } from '../config'

interface User {
  id: string
  name: string
  email: string
  email_verified?: boolean
}

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, name?: string) => Promise<{ user_id: string }>
  verifyEmail: (email: string, code: string) => Promise<void>
  logout: () => void
  authFetch: (url: string, options?: RequestInit) => Promise<Response>
  getAccessToken: () => string | null
}

const AuthContext = createContext<AuthState | null>(null)

function extractError(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((e: any) => (typeof e.msg === 'string' ? e.msg.replace(/^Value error,\s*/i, '') : ''))
      .filter(Boolean)
      .join('; ')
  }
  return ''
}

const TOKEN_KEY = 'molly_access_token'
const REFRESH_KEY = 'molly_refresh_token'

function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

function getStoredRefresh(): string | null {
  try { return localStorage.getItem(REFRESH_KEY) } catch { return null }
}

function storeTokens(access: string, refresh: string) {
  try {
    localStorage.setItem(TOKEN_KEY, access)
    localStorage.setItem(REFRESH_KEY, refresh)
  } catch { /* noop */ }
}

function clearTokens() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
  } catch { /* noop */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(getStoredToken)
  const [refreshToken, setRefreshToken] = useState<string | null>(getStoredRefresh)
  const [isLoading, setIsLoading] = useState(true)

  const tryRefresh = useCallback(async (rToken: string): Promise<string | null> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rToken }),
      })
      if (res.ok) {
        const data = await res.json()
        return data.access_token
      }
    } catch { /* offline */ }
    return null
  }, [])

  const fetchUser = useCallback(async (token: string): Promise<User | null> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) return await res.json()
    } catch { /* noop */ }
    return null
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const storedAccess = getStoredToken()
      const storedRefresh = getStoredRefresh()

      if (storedAccess) {
        const u = await fetchUser(storedAccess)
        if (u && !cancelled) {
          setUser(u)
          setAccessToken(storedAccess)
          setRefreshToken(storedRefresh)
          setIsLoading(false)
          return
        }
      }

      if (storedRefresh) {
        const newAccess = await tryRefresh(storedRefresh)
        if (newAccess) {
          const u = await fetchUser(newAccess)
          if (u && !cancelled) {
            setUser(u)
            setAccessToken(newAccess)
            setRefreshToken(storedRefresh)
            storeTokens(newAccess, storedRefresh)
            setIsLoading(false)
            return
          }
        }
      }

      if (!cancelled) {
        clearTokens()
        setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [fetchUser, tryRefresh])

  const authFetch = useCallback(async (url: string, options: RequestInit = {}): Promise<Response> => {
    let token = accessToken
    if (url.includes('/api/auth/refresh')) token = null

    const headers = new Headers(options.headers)
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json')

    let res = await fetch(url, { ...options, headers })

    if (res.status === 401 && refreshToken) {
      const newAccess = await tryRefresh(refreshToken)
      if (newAccess) {
        setAccessToken(newAccess)
        storeTokens(newAccess, refreshToken!)
        headers.set('Authorization', `Bearer ${newAccess}`)
        res = await fetch(url, { ...options, headers })
      } else {
        clearTokens()
        setUser(null)
        setAccessToken(null)
        setRefreshToken(null)
      }
    }

    return res
  }, [accessToken, refreshToken, tryRefresh])

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: i18n.t('login.loginFailed') }))
      throw new Error(extractError(err.detail) || i18n.t('login.loginFailed'))
    }
    const data = await res.json()
    setUser(data.user)
    setAccessToken(data.access_token)
    setRefreshToken(data.refresh_token)
    storeTokens(data.access_token, data.refresh_token)
  }, [])

  const register = useCallback(async (email: string, password: string, name?: string) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, timezone }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: i18n.t('login.registrationFailed') }))
      throw new Error(extractError(err.detail) || i18n.t('login.registrationFailed'))
    }
    return await res.json()
  }, [])

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const res = await fetch(`${API_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: i18n.t('login.verificationFailed') }))
      throw new Error(extractError(err.detail) || i18n.t('login.verificationFailed'))
    }
    const data = await res.json()
    setUser(data.user)
    setAccessToken(data.access_token)
    setRefreshToken(data.refresh_token)
    storeTokens(data.access_token, data.refresh_token)
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    setAccessToken(null)
    setRefreshToken(null)
    clearTokens()
  }, [])

  const getAccessToken = useCallback(() => accessToken, [accessToken])

  return (
    <AuthContext.Provider value={{
      user, accessToken, refreshToken,
      isAuthenticated: !!user,
      isLoading,
      login, register, verifyEmail, logout,
      authFetch, getAccessToken,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
