// K022 · Infrastructure: código de retiro (anexos H p. 21). Se cifra con una clave
// externa a la base y se busca por una huella HMAC; el texto nunca se guarda legible.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto"
import type { PickupCodes } from "../../application/reservations/ports.js"
import { PICKUP_CODE_ALPHABET, PICKUP_CODE_LENGTH } from "../../domain/reservations.js"

const FORMAT = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const AAD = Buffer.from("rescate-pickup-code")

export function createPickupCodes(key: Uint8Array): PickupCodes {
  if (key.byteLength < 32) throw new Error("PICKUP_CODE_KEY requiere al menos 32 bytes")
  // Subclaves separadas: cifrar y buscar no comparten material.
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `rescate-pickup-code-${purpose}-v1`, 32))
  const encryption = derive("encryption")
  const lookup = derive("fingerprint")
  const fingerprint = (code: string) => new Uint8Array(createHmac("sha256", lookup).update(code).digest())
  return {
    issue() {
      // randomInt es uniforme sobre 32 símbolos: 40 bits aleatorios por código.
      const code = Array.from({ length: PICKUP_CODE_LENGTH }, () => PICKUP_CODE_ALPHABET[randomInt(32)]).join("")
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", encryption, iv).setAAD(AAD)
      const body = Buffer.concat([cipher.update(code, "utf8"), cipher.final()])
      return {
        code,
        ciphertext: new Uint8Array(Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body])),
        fingerprint: fingerprint(code),
      }
    },
    reveal(ciphertext) {
      const bytes = Buffer.from(ciphertext)
      if (bytes[0] !== FORMAT || bytes.length !== 1 + IV_BYTES + TAG_BYTES + PICKUP_CODE_LENGTH) {
        throw new Error("Código cifrado con formato desconocido")
      }
      const decipher = createDecipheriv("aes-256-gcm", encryption, bytes.subarray(1, 1 + IV_BYTES)).setAAD(AAD)
      decipher.setAuthTag(bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES))
      return Buffer.concat([decipher.update(bytes.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8")
    },
    fingerprint,
  }
}
