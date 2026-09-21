// Fallos del port criptográfico; no son credenciales incorrectas ni estados HTTP.
export class PasswordHashingCapacityError extends Error {
  constructor() {
    super("La capacidad de cálculo de contraseñas está ocupada")
    this.name = "PasswordHashingCapacityError"
  }
}

export class InvalidPasswordCredentialError extends Error {
  constructor() {
    super("Formato o parámetros de credencial no admitidos")
    this.name = "InvalidPasswordCredentialError"
  }
}

export class IdentityError extends Error {
  constructor(readonly code: "invalid_input" | "email_exists" | "invalid_credentials" | "login_blocked" | "no_session",
    readonly fields: string[] = [], readonly retryAfter = 0) {
    super(code)
  }
}
