import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import type { Request } from 'express'
import { addressKey, clientAddress, readProxySecret, resolveClientAddress } from '../src/http/client-address.js'
import { createTrafficLimits, TrafficLimitError } from '../src/http/rate-limits.js'

const secret = 'a'.repeat(43)
function signed(ip: string, at = Date.now()): Record<string, string> {
  return { 'x-rescate-proxy-secret': secret, 'x-rescate-client-ip': ip,
    'x-rescate-client-ip-signature': `${at}.${createHmac('sha256', secret).update(`${at}.${ip}`).digest('base64url')}` }
}
function request(headers: Record<string, string>, socket = '::ffff:192.0.2.1'): Request {
  return { get: (name: string) => headers[name], socket: { remoteAddress: socket } } as unknown as Request
}

test('solo el proxy autenticado declara el origen; una cabecera falsificada conserva el límite del socket', () => {
  const limits = createTrafficLimits()
  for (let n = 0; n < 30; n++) {
    const req = request({ 'x-forwarded-for': `198.51.100.${n}`, 'x-vercel-forwarded-for': `198.51.100.${n}`,
      'x-rescate-client-ip': `198.51.100.${n}`, 'x-rescate-proxy-secret': 'secreto-falso' })
    resolveClientAddress(req, secret)
    limits.login(clientAddress(req))
  }
  const forged = request({ 'x-forwarded-for': '203.0.113.1', 'x-vercel-forwarded-for': '203.0.113.1' })
  resolveClientAddress(forged, secret)
  assert.throws(() => limits.login(clientAddress(forged)), TrafficLimitError)
  const real = request(signed('203.0.113.1'))
  assert.equal(resolveClientAddress(real, secret), '203.0.113.1')
  limits.login(clientAddress(real))
  assert.equal(resolveClientAddress(request(signed('1.2.3.4, 5.6.7.8')), secret), '192.0.2.1')
})

test('el CDN autenticado no basta: despliegues antiguos no pueden firmar una IP declarada por el cliente', () => {
  const now = Date.now()
  for (const headers of [
    { 'x-rescate-proxy-secret': secret, 'x-vercel-forwarded-for': '203.0.113.1' },
    { 'x-rescate-proxy-secret': secret, 'x-rescate-client-ip': '203.0.113.1' },
    { ...signed('203.0.113.1'), 'x-rescate-client-ip': '203.0.113.2' },
    { ...signed('203.0.113.1'), 'x-rescate-proxy-secret': 'incorrecto' },
    { ...signed('203.0.113.1'), 'x-rescate-client-ip-signature': `${now}.${'x'.repeat(43)}` },
    { ...signed('203.0.113.1'), 'x-rescate-client-ip-signature': 'incompleta' },
    signed('203.0.113.1', now - 60_001), signed('203.0.113.1', now + 60_001),
  ]) assert.equal(resolveClientAddress(request(headers), secret, now), '192.0.2.1')
})

test('variar cabeceras genéricas conserva el límite de la IP firmada y otro origen conserva su ventana', () => {
  const limits = createTrafficLimits()
  for (let n = 0; n < 30; n++) {
    const req = request({ ...signed('203.0.113.1'), 'x-forwarded-for': `198.51.100.${n}`, 'x-vercel-forwarded-for': `198.51.100.${n}` })
    resolveClientAddress(req, secret); limits.login(clientAddress(req))
  }
  const same = request(signed('203.0.113.1')); resolveClientAddress(same, secret)
  assert.throws(() => limits.login(clientAddress(same)), TrafficLimitError)
  const other = request(signed('203.0.113.2')); resolveClientAddress(other, secret)
  assert.doesNotThrow(() => limits.login(clientAddress(other)))
})

test('IPv6 agrupa representaciones equivalentes y direcciones de una misma /64', () => {
  for (const ip of ['2001:0db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff']) assert.equal(addressKey(ip), '2001:db8:1:2::/64')
  assert.notEqual(addressKey('2001:db8:1:3::1'), addressKey('2001:db8:1:2::1'))
  assert.equal(addressKey('::ffff:192.0.2.1'), '192.0.2.1')
  assert.equal(addressKey('::ffff:c000:201'), '192.0.2.1')
  for (const value of ['', 'unknown', '1.2.3.4:80', '2001:db8::1%eth0']) assert.equal(addressKey(value), null)
  assert.throws(() => readProxySecret({ NODE_ENV: 'production' }))
})
