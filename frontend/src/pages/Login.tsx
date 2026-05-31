import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { Input } from '@/components/ui/input'
import { API_URL } from '../config'

type Stage = 'login' | 'register' | 'verify'

export default function Login() {
  const auth = useAuth()
  const { t } = useTranslation()

  const [stage, setStage] = useState<Stage>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const clearError = () => setError('')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    setBusy(true)
    try {
      await auth.login(email, password)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    setBusy(true)
    try {
      await auth.register(email, password, name || undefined)
      setStage('verify')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    setBusy(true)
    try {
      await auth.verifyEmail(email, code)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleResend = async () => {
    clearError()
    setBusy(true)
    try {
      await fetch(`${API_URL}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setError(t('login.codeResent'))
    } catch {
      setError(t('login.codeResendFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (stage === 'verify') {
    return (
      <div className="h-dvh w-full bg-[#fafafa] flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="flex justify-center mb-4">
              <img src="./logo.jpg" alt={t('login.title')} className="w-16 h-16 rounded-full object-cover border border-slate-200 shadow-sm" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">{t('login.checkEmailTitle')}</h1>
            <p className="text-slate-500 text-sm">
              {t('login.sentCodeTo')} <strong className="text-slate-700">{email}</strong>
            </p>
          </div>
          <form onSubmit={handleVerify} className="space-y-4">
            <Input
              placeholder={t('login.placeholderCode')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              className="text-center text-lg tracking-widest bg-white border-slate-200"
              autoFocus
            />
            {error && <p className="text-rose-500 text-sm text-center">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="w-full py-2.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {busy ? t('login.verifying') : t('login.verifyEmail')}
            </button>
          </form>
          <button
            onClick={handleResend}
            disabled={busy}
            className="w-full text-slate-400 text-sm hover:text-slate-600 transition-colors"
          >
            {t('login.resendCode')}
          </button>
          <button
            onClick={() => { setStage('register'); setError('') }}
            className="w-full text-slate-400 text-sm hover:text-slate-600 transition-colors"
          >
            {t('login.backToSignup')}
          </button>
        </div>
      </div>
    )
  }

  const isRegister = stage === 'register'

  return (
    <div className="h-dvh w-full bg-[#fafafa] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <img src="./logo.jpg" alt={t('login.title')} className="w-16 h-16 rounded-full object-cover border border-slate-200 shadow-sm" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">{t('login.title')}</h1>
          <p className="text-slate-500 text-sm">
            {isRegister ? t('login.createAccount') : t('login.signInPrompt')}
          </p>
        </div>
        <form
          onSubmit={isRegister ? handleRegister : handleLogin}
          className="space-y-4"
        >
          {isRegister && (
            <Input
              placeholder={t('login.placeholderName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-white border-slate-200"
            />
          )}
          <Input
            type="email"
            placeholder={t('login.placeholderEmail')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="bg-white border-slate-200"
          />
          <Input
            type="password"
            placeholder={t('login.placeholderPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="bg-white border-slate-200"
          />
          {error && <p className="text-rose-500 text-sm text-center">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            {busy
              ? (isRegister ? t('login.creating') : t('login.signingIn'))
              : (isRegister ? t('login.createAccountBtn') : t('login.signInBtn'))}
          </button>
        </form>
        <button
          onClick={() => { setStage(isRegister ? 'login' : 'register'); setError('') }}
          className="w-full text-slate-400 text-sm hover:text-slate-600 transition-colors"
        >
          {isRegister ? t('login.switchToSignin') : t('login.switchToSignup')}
        </button>
      </div>
    </div>
  )
}
