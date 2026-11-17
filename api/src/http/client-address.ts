import { createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Request } from 'express'

const addresses = new WeakMap<Request, string>()

/** IPv4 canónica e IPv6 agrupada por /64, incluidas las representaciones IPv4-mapped. */
export function addressKey(value: string): string | null {
  if (value.includes('%')) return null
  const family = isIP(value)
  if (family === 4) return value
  if (family !== 6) return null
  let text = value.toLowerCase()
  if (text.includes('.')) {
    const index = text.lastIndexOf(':')
    const octets = text.slice(index + 1).split('.').map(Number)
    text = `${text.slice(0, index)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const [left, right] = text.split('::')
  const prefix = left ? left.split(':') : []
  const suffix = right ? right.split(':') : []
  const words = right === undefined ? prefix : [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix]
  const numbers = words.map(word => Number.parseInt(word, 16))
  if (numbers.slice(0, 5).every(n => n === 0) && numbers[5] === 0xffff) {
    return `${numbers[6]! >> 8}.${numbers[6]! & 255}.${numbers[7]! >> 8}.${numbers[7]! & 255}`
  }
  return `${numbers.slice(0, 4).map(n => n.toString(16)).join(':')}::/64`
}

/** Las URLs de despliegues anteriores también inyectan el secreto: la IP requiere firma propia. */
function signedAddress(req: Request, secret: string, now: number): string | null {
  const ip = req.get('x-rescate-client-ip') ?? ''
  const address = addressKey(ip)
  const signature = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(req.get('x-rescate-client-ip-signature') ?? '')
  if (!address || !signature || Math.abs(now - Number(signature[1])) > 60_000) return null
  const actual = Buffer.from(signature[2]!, 'base64url')
  const expected = createHmac('sha256', secret).update(`${signature[1]}.${ip}`).digest()
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? address : null
}

export function resolveClientAddress(req: Request, proxySecret: string | undefined, now = Date.now()): string {
  const presented = req.get('x-rescate-proxy-secret') ?? ''
  const expected = Buffer.from(proxySecret ?? '')
  const actual = Buffer.from(presented)
  const trusted = expected.length >= 32 && actual.length === expected.length && timingSafeEqual(expected, actual)
  const forwarded = trusted ? signedAddress(req, proxySecret!, now) : null
  const address = forwarded ?? addressKey(req.socket.remoteAddress ?? '') ?? 'unknown'
  addresses.set(req, address)
  return address
}

export const clientAddress = (req: Request): string => addresses.get(req) ?? addressKey(req.socket.remoteAddress ?? '') ?? 'unknown'

export function readProxySecret(environment: NodeJS.ProcessEnv): string | undefined {
  const secret = environment.API_PROXY_SECRET || undefined
  if (secret !== undefined && (!/^[A-Za-z0-9+/=_-]{32,256}$/.test(secret))) throw new Error('API_PROXY_SECRET requiere un secreto aleatorio de al menos 32 caracteres')
  if (!secret && environment.NODE_ENV === 'production') throw new Error('Falta API_PROXY_SECRET del proxy Vercel')
  return secret
}
