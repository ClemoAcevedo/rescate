// Regresión del recolector: ejecutar código antes y después de destruir un documento.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'rescate-coverage-check-'))
process.env.WEB_COVERAGE_DIR = dir
const { chromium } = await import('./support/browser.mjs')
const server = createServer((req, res) => {
  if (req.url.startsWith('/src/')) {
    const name = req.url.includes('first') ? 'firstDocument' : 'secondDocument'
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(`function ${name}() { window.executed = '${name}' } ${name}()`)
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<script src="/src/${req.url === '/second' ? 'second' : 'first'}.ts"></script>`)
  }
})
let browser
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(`${base}/first`)
  assert.equal(await page.evaluate(() => window.executed), 'firstDocument')
  await page.reload()
  await page.goto(`${base}/second`)
  assert.equal(await page.evaluate(() => window.executed), 'secondDocument')
  await page.goBack()
  await page.goForward()
  await browser.close()
  browser = null
  const counts = new Map()
  for (const file of await readdir(dir)) {
    for (const entry of JSON.parse(await readFile(join(dir, file), 'utf8'))) {
      for (const fn of entry.functions) counts.set(fn.functionName, (counts.get(fn.functionName) ?? 0) + fn.ranges[0].count)
    }
  }
  assert.ok(counts.get('firstDocument') >= 1, 'Conservar ejecución anterior a goto/reload')
  assert.ok(counts.get('secondDocument') >= 1, 'Conservar ejecución anterior a volver/avanzar')
  console.log('PASS cobertura: conserva ejecución entre goto, reload, goBack y goForward')
} finally {
  await browser?.close()
  const stopped = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await stopped
  await rm(dir, { recursive: true, force: true })
}
