import { createHash, randomBytes } from "node:crypto"
import type { SessionCredentials } from "../../application/identity/ports.js"

const digest = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest())

export function createSessionCredentials(): SessionCredentials {
  return {
    issue() {
      const bytes = randomBytes(32)
      return { secret: bytes.toString("base64url"), tokenHash: digest(bytes) }
    },
    fingerprint(secret) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null
      const bytes = Buffer.from(secret, "base64url")
      // Buffer decodifica variantes permisivamente; exigir un único texto por secreto.
      if (bytes.length !== 32 || bytes.toString("base64url") !== secret) return null
      return digest(bytes)
    },
  }
}
