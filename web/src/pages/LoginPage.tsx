import './Page.css'

export function LoginPage() {
  return (
    <section className="page" aria-labelledby="login-title">
      <p className="page__eyebrow">Cuenta</p>
      <h1 id="login-title">Iniciar sesión</h1>
      <p className="page__description">
        Esta pantalla permitirá acceder a Rescate cuando la autenticación esté
        disponible.
      </p>
    </section>
  )
}
