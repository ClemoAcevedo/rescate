// Recorridos con respuestas controladas; no requiere PostgreSQL. La suite real de CI
// usa el mismo recolector, con WEB_COVERAGE_DIR, sobre test:web:compose.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'

const api = fileURLToPath(new URL('../', import.meta.url))
const web = fileURLToPath(new URL('../../web/', import.meta.url))
const dir = `${api}coverage/web/raw`
await rm(`${api}coverage/web`, { recursive: true, force: true })
await mkdir(dir, { recursive: true })
const vite = await createServer({ root: web, server: { host: '127.0.0.1', port: 0, open: false } })
let passed = false
try {
  await vite.listen()
  for (const script of ['test:web:accessibility', 'test:web:responsive', 'test:web:logout', 'test:web:chat']) {
    const { stdout, stderr } = await promisify(execFile)('npm', ['run', script], { cwd: api, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, WEB_URL: vite.resolvedUrls.local[0].replace(/\/$/, ''), WEB_COVERAGE_DIR: dir } })
    process.stdout.write(stdout); process.stderr.write(stderr)
  }
  passed = true
} finally {
  await vite.close()
  if (passed) {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/web-coverage-report.mjs'], {
      cwd: api, env: { ...process.env, WEB_COVERAGE_DIR: dir, WEB_COVERAGE_SCOPE: 'Respuestas controladas: accesibilidad, responsive, logout y chat' } })
    process.stdout.write(stdout)
  }
}
