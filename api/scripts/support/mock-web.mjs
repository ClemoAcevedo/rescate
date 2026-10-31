// Servidor HTTP real de prueba, sin persistencia ni políticas de la API real.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from '../../../web/node_modules/vite/dist/node/index.js'
import { assertContract } from '../../test/support/openapi.ts'

export async function startMockWeb(handler) {
  const failures = []
  const requests = []
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://mock.local')
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16 * 1024) throw new Error('Cuerpo mock demasiado grande')
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString()
      const request = { method: req.method, url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      requests.push({ method: req.method, path: url.pathname })
      const { status = 200, body, disconnect = false, wait, headers = {} } = await handler(request)
      const response = new Response(null, { status, headers: { 'cache-control': 'no-store' } })
      assertContract(req.method, url.pathname, response, body)
      if (wait) await wait
      if (disconnect) { res.destroy(); return }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(status === 204 ? undefined : JSON.stringify(body))
    } catch (error) {
      failures.push(error)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Mock inesperado' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let vite
  const close = async () => {
    await vite?.close()
    const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await stopped
  }
  try {
    const root = fileURLToPath(new URL('../../../web/', import.meta.url))
    vite = await createViteServer({ root, configFile: `${root}vite.config.ts`, server: {
      host: '127.0.0.1', port: 0, open: false,
      proxy: { '/api': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '') } },
    } })
    await vite.listen()
    return { url: vite.resolvedUrls.local[0].replace(/\/$/, ''), requests, failures, close }
  } catch (error) { await close(); throw error }
}
