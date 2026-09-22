import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { authErrorMessage, fieldErrors, useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'

export function RegisterPage() {
  const { status, register } = useAuth()
  const form = useRef<HTMLFormElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.current?.reportValidity()) return
    setErrors({}); setMessage(null); setSubmitting(true)
    try {
      await register({ email, password }); setPassword('')
      setMessage('Tu cuenta fue creada. El registro no inicia sesión: ahora puedes acceder con tus credenciales.')
    } catch (error) { setErrors(fieldErrors(error)); setMessage(authErrorMessage(error, 'register')) } finally { setSubmitting(false) }
  }
  const waitingForSession = status === 'checking'
  return <main className="page-content"><Card as="section" className="content-card auth-card" aria-labelledby="register-title">
    <p className="eyebrow">Cuenta</p><h1 id="register-title">Registro</h1>
    <p>Crea una cuenta. La habilitación para operar establecimientos se gestiona por separado.</p>
    {waitingForSession && <Alert className="form-result" role="status">Preparando la protección del formulario…</Alert>}
    {message && <Alert className="form-result" tone={errors.email || errors.password ? 'danger' : 'success'} role={errors.email || errors.password ? 'alert' : 'status'}>{message}</Alert>}
    <form ref={form} className="auth-form" onSubmit={submit}>
      <FormField label="Correo electrónico" error={errors.email} required>{(control) => <Input {...control} name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />}</FormField>
      <FormField label="Contraseña" hint="Debe tener al menos 12 caracteres." error={errors.password} required>{(control) => <Input {...control} name="password" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />}</FormField>
      <Button type="submit" block loading={submitting} disabled={waitingForSession}>{submitting ? 'Creando cuenta…' : 'Crear cuenta'}</Button>
    </form>
    <p className="auth-switch">¿Ya tienes una cuenta? <Link to="/login">Inicia sesión</Link>.</p>
  </Card></main>
}
