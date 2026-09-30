import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function createCsrfTokens(key: Uint8Array) {
  if (key.byteLength < 32) throw new Error("CSRF_SIGNING_KEY requiere al menos 32 bytes")
  const secret = Buffer.from(key)
  const signature = (payload: string, binding: string) => createHmac("sha256", secret)
    .update(JSON.stringify(["rescate-csrf-v1", binding, payload])).digest()
  return {
    issue(binding: string, expiresAt: number): string {
      const payload = `1.${expiresAt}.${randomBytes(32).toString("base64url")}`
      return `${payload}.${signature(payload, binding).toString("base64url")}`
    },
    valid(token: string, binding: string, now: number, maximumExpiry: number): boolean {
      if (!/^1\.[0-9]{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return false
      const [version, expiry, nonce, signed] = token.split(".") as [string, string, string, string]
      const expiresAt = Number(expiry)
      if (expiresAt <= now || expiresAt > maximumExpiry) return false
      const supplied = Buffer.from(signed, "base64url")
      if (supplied.toString("base64url") !== signed) return false
      const expected = signature(`${version}.${expiry}.${nonce}`, binding)
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    },
  }
}
