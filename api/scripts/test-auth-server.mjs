// Servidor aislado de evidencia: HTTPS con certificado efímero y página vacía.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import express from 'express'
import { createApi } from '../dist/composition.js'
if (!process.send || !/^rescate_k008_test_/.test(new URL(process.env.DATABASE_URL).pathname.slice(1))) throw new Error('Solo pruebas aisladas vía IPC')
const entry = express()
let api
entry.get('/', (_req, res) => res.type('html').send('<!doctype html><title>K008 HTTPS fixture</title>'))
entry.use((req, res, next) => api.app(req, res, next))
const server = createServer({ cert: readFileSync(process.env.TEST_CERT), key: readFileSync(process.env.TEST_KEY) }, entry)
server.listen(Number(process.env.TEST_PORT), '127.0.0.1', () => {
  const port = server.address().port
  api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: `https://localhost:${port}` })
  process.send({ port })
})
process.once('SIGTERM', () => { server.close(() => { void api.close().then(() => process.exit(0)) }); server.closeAllConnections() })
