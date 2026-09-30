import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import type { PasswordCredential, PasswordHasher, ScryptParameters } from "../../application/identity/ports.js"
import { InvalidPasswordCredentialError, PasswordHashingCapacityError } from "../../application/identity/errors.js"

// Medidos con scripts/benchmark-scrypt.mjs antes de elegir el perfil de creación.
// Configuración de NUEVAS credenciales: no sustituye parámetros persistidos.
export const SCRYPT_CREATION_PARAMETERS: Readonly<ScryptParameters> = Object.freeze({ N: 65536, r: 8, p: 2 })
const MAXMEM = 192 * 1024 * 1024 // Techo por cálculo, incluye margen de OpenSSL.
const MAX_CONCURRENT = 2 // Por instancia compartida del adaptador; sin cola ilimitada.

function checkedParameters(parameters: ScryptParameters): ScryptParameters {
  const { N, r, p } = parameters
  // Lista acotada de perfiles evaluados: no ejecutar parámetros arbitrarios de DB.
  if (r !== 8 || !((N === 65536 && p === 2) || (N === 131072 && p === 1))) {
    throw new InvalidPasswordCredentialError()
  }
  return { N, r, p }
}

/** Composition deberá crear UNA instancia y compartirla entre hash y verify. */
export function createPasswordHasher(creationParameters: ScryptParameters = SCRYPT_CREATION_PARAMETERS): PasswordHasher {
  const creation = checkedParameters(creationParameters)
  let active = 0

  async function derive(password: string, salt: Uint8Array, parameters: ScryptParameters): Promise<Buffer> {
    if (active >= MAX_CONCURRENT) throw new PasswordHashingCapacityError()
    active++
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        // API asíncrona: libuv hace el cálculo, sin bloquear el event loop.
        scrypt(password, salt, 64, { ...parameters, maxmem: MAXMEM }, (error, key) => {
          if (error) reject(error)
          else resolve(key)
        })
      })
    } finally {
      active--
    }
  }

  return {
    async hash(password) {
      const salt = randomBytes(16)
      const hash = await derive(password, salt, creation)
      return { hash: new Uint8Array(hash), salt: new Uint8Array(salt), parameters: { ...creation } }
    },
    async verify(password: string, credential: PasswordCredential) {
      const parameters = checkedParameters(credential.parameters)
      if (!(credential.hash instanceof Uint8Array) || credential.hash.byteLength !== 64
        || !(credential.salt instanceof Uint8Array) || credential.salt.byteLength !== 16) {
        throw new InvalidPasswordCredentialError()
      }
      const expected = Buffer.from(credential.hash)
      const actual = await derive(password, Buffer.from(credential.salt), parameters)
      try {
        return timingSafeEqual(actual, expected)
      } finally {
        actual.fill(0)
      }
    },
  }
}

/** Solo señuelo en memoria para verificar cuentas inexistentes; nunca se persiste. */
export function createDummyCredential(): PasswordCredential {
  return { hash: randomBytes(64), salt: randomBytes(16), parameters: { ...SCRYPT_CREATION_PARAMETERS } }
}
