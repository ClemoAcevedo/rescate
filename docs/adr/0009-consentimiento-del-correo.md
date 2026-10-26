# ADR 0009: consentimiento para tratar el correo

Estado: adoptada a partir del feedback de E2, que pidió registrar el consentimiento
del usuario por el uso de su correo. Pendiente de confirmar con el equipo docente si
esperaban una columna o una tabla.

## Decisión

Registrarse exige `privacyConsent: true`. Application lo valida y, en la misma
transacción que crea el usuario y su credencial, inserta una fila en
`user_consents` con el propósito (`account_email`), la versión del texto aceptado
(`PRIVACY_POLICY_VERSION` en Domain) y el instante. Sin consentimiento la API
responde 422 y no guarda el correo. El formulario de registro lo pide con un
checkbox obligatorio.

Un índice único parcial permite un solo consentimiento vigente por persona y
propósito; revocar es llenar `revoked_at`, y la fila queda como historial.

Se apoya en la Ley 21.719 de protección de datos personales: el consentimiento debe
ser específico, informado y revocable, y quien trata los datos tiene que poder
demostrar que lo obtuvo.

## Alternativas descartadas

- **Columna booleana en `users`.** No guarda qué texto se aceptó ni cuándo, y al
  revocar se pierde la evidencia de que antes existía.
- **Columna `consented_at` en `users`.** Guarda el cuándo, pero no la versión ni el
  historial de revocaciones, y no sirve si aparece otro propósito (por ejemplo,
  avisos por correo).

## Pendiente

Revocar el consentimiento y borrar la cuenta no tienen endpoint todavía; se
agregan cuando exista la gestión de cuenta.
