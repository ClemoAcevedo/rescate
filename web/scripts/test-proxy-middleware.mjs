import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import middleware from '../middleware.ts'

const secret = 'middleware-test-'.repeat(3)
function configure(t, value = secret) {
  const original = process.env.API_PROXY_SECRET
  t.after(() => { if (original === undefined) delete process.env.API_PROXY_SECRET; else process.env.API_PROXY_SECRET = original })
  if (value === undefined) delete process.env.API_PROXY_SECRET; else process.env.API_PROXY_SECRET = value
}

test('firma la IP del runtime, reemplaza la declaración del cliente y conserva sesión/CSRF', async t => {
  configure(t)
  const request = new Request('https://web.example/api/auth/login', { method: 'POST', headers: {
    'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.1', 'x-vercel-forwarded-for': '198.51.100.2',
    'x-rescate-client-ip': '198.51.100.3', 'x-rescate-client-ip-signature': 'firma-falsa',
    cookie: 'session=ficticia', origin: 'https://web.example', 'x-csrf-token': 'csrf-ficticio',
  } })
  const response = await middleware(request)
  const forwarded = name => response.headers.get('x-middleware-request-' + name)
  assert.equal(response.headers.get('x-middleware-next'), '1')
  assert.equal(forwarded('x-rescate-client-ip'), '203.0.113.10')
  const [timestamp, signature] = forwarded('x-rescate-client-ip-signature').split('.')
  assert.ok(Math.abs(Date.now() - Number(timestamp)) < 1000)
  assert.equal(signature, createHmac('sha256', secret).update(`${timestamp}.203.0.113.10`).digest('base64url'))
  for (const name of ['cookie', 'origin', 'x-csrf-token']) assert.equal(forwarded(name), request.headers.get(name))
  assert.equal(JSON.stringify([...response.headers]).includes(secret), false)
})

test('solo lee cabeceras: no consume una foto de 5 MiB', async t => {
  configure(t)
  const request = new Request('https://web.example/api/lots/ficticio/photos', {
    method: 'POST', headers: { 'x-real-ip': '203.0.113.10' }, body: new Uint8Array(5 * 1024 * 1024),
  })
  Object.defineProperty(request, 'body', { get() { throw new Error('El middleware no debe inspeccionar el cuerpo') } })
  assert.equal((await middleware(request)).headers.get('x-middleware-next'), '1')
  assert.equal(request.bodyUsed, false)
})

test('sin IP del runtime o clave no continúa con una declaración sin firma', async t => {
  configure(t)
  const response = await middleware(new Request('https://web.example/api/auth/session'))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE')
  delete process.env.API_PROXY_SECRET
  assert.equal((await middleware(new Request('https://web.example/api/auth/session', { headers: { 'x-real-ip': '203.0.113.10' } }))).status, 503)
})
