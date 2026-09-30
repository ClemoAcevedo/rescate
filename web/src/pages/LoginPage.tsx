import { useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authErrorMessage, fieldErrors, useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'

function safeDestination(value: string | null) { return value && value.startsWith('/') && !value.startsWith('//') ? value : '/lotes' }

export function LoginPage() {
  const { status, login } = useAuth()
  const form = useRef<HTMLFormElement>(null); const navigate = useNavigate(); const { search } = useLocation()
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({}); const [message, setMessage] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.current?.reportValidity()) return
    setErrors({}); setMessage(null); setSubmitting(true)
    try { await login({ email, password }); setPassword(''); navigate(safeDestination(new URLSearchParams(search).get('from')), { replace: true })
    } catch (error) { setErrors(fieldErrors(error)); setMessage(authErrorMessage(error, 'login')) } finally { setSubmitting(false) }
  }
  const waitingForSession = status === 'checking'
  return <main className="page-content"><Card as="section" className="content-card auth-card" aria-labelledby="login-title">
    <p className="eyebrow">Cuenta</p><h1 id="login-title">Iniciar sesión</h1><p>Ingresa con el correo y la contraseña de tu cuenta.</p>
    {waitingForSession && <Alert className="form-result" role="status">Comprobando la sesión actual…</Alert>}
    {message && <Alert className="form-result" tone="danger" role="alert">{message}</Alert>}
    <form ref={form} className="auth-form" onSubmit={submit}>
      <FormField label="Correo electrónico" error={errors.email} required>{(control) => <Input {...control} name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />}</FormField>
      <FormField label="Contraseña" error={errors.password} required>{(control) => <Input {...control} name="password" type="password" autoComplete="current-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />}</FormField>
      <Button type="submit" block loading={submitting} disabled={waitingForSession}>{submitting ? 'Ingresando…' : 'Iniciar sesión'}</Button>
    </form>
    <p className="auth-switch">¿Aún no tienes cuenta? <Link to="/registro">Regístrate</Link>.</p>
  </Card></main>
}
