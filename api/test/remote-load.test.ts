import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
// @ts-expect-error El runner de carga es JavaScript, igual que los scripts de deploy.
import { remoteConfig, shellQuote } from '../scripts/support/remote-k6.mjs'

test('la carga local conserva su configuración; el modo remoto exige origen alcanzable y destino SSH sin opciones', () => {
  assert.equal(remoteConfig({}), null)
  assert.deepEqual(remoteConfig({ K6_SSH_TARGET: 'tester@generador', K6_REMOTE_API_URL: 'http://192.168.1.20:3001' }), {
    target: 'tester@generador', apiUrl: 'http://192.168.1.20:3001', port: 3001,
  })
  for (const target of ['-oProxyCommand=echo', 'tester@host;echo', 'host\nother']) {
    assert.throws(() => remoteConfig({ K6_SSH_TARGET: target, K6_REMOTE_API_URL: 'http://192.168.1.20:3001' }))
  }
  for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'file:///tmp/test',
    'http://user:password@192.168.1.20:3001', 'http://192.168.1.20:3001/path', 'http://192.168.1.20:3001/?token=secret']) {
    assert.throws(() => remoteConfig({ K6_SSH_TARGET: 'generador', K6_REMOTE_API_URL: url }))
  }
})

test('los parámetros que SSH pasa por una shell conservan comillas y metacaracteres como datos', () => {
  const input = "https://example.test/a'b; printf injected; $(printf expansion) `printf backtick`\nsecond-line"
  assert.equal(execFileSync('sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' }), input)
})
