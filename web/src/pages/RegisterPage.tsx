import './Page.css'

export function RegisterPage() {
  return (
    <section className="page" aria-labelledby="register-title">
      <p className="page__eyebrow">Cuenta</p>
      <h1 id="register-title">Registro</h1>
      <p className="page__description">
        Aquí podrás crear una cuenta para participar en Rescate. El formulario
        estará disponible próximamente.
      </p>
    </section>
  )
}
