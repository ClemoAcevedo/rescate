import { Card } from '../components/ui/Card'
export function LoginPage() {
  return (
    <main className="page-content">
      <Card as="section" className="content-card" aria-labelledby="login-title">
        <p className="eyebrow">Cuenta</p>
        <h1 id="login-title">Iniciar sesión</h1>
        <p>Esta pantalla permitirá acceder a Rescate cuando la autenticación esté disponible.</p>
      </Card>
    </main>
  )
}
