import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromium } from 'playwright'

// K039: chat visible del anexo H (p. 19): P95 ≤ 7 s desde la confirmación de guardado hasta mostrar
// el mensaje en otro navegador con la vista activa, sobre al menos 100 mensajes. Titular y operador
// conversan en la vista real de K038 contra Vite HTTPS → proxy → API → PostgreSQL. El reloj común
// es el del equipo: Node anota el 201 que recibe quien envía y la página que recibe anota, con un
// MutationObserver, el instante en que el mensaje aparece. Requiere servicios iniciados
// (test:web:chat-latency:compose los levanta). La meta se informa; no hace fallar la prueba.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const MESSAGES = 100
const GOAL_MS = 7000
// Primero escribe solo el titular y después solo el operador: quien recibe no envía, porque la vista
// recarga la conversación tras cada envío propio y esa recarga, no la consulta cada 5 s, acotaría la
// demora. Uno cada 6 s (10/min) queda bajo el cupo de 12/min y no coincide con el ciclo de 5 s, así
// que las demoras recorren todo el ciclo de consulta.
const INTERVAL_MS = 6000
const password = 'K039-chat-latency-password'
const run = Date.now()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })

/** Cuenta propia en su contexto; las cuentas se crean en secuencia (K008 limita scrypt a 2 a la vez). */
async function account(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport: { width: 1366, height: 768 } })
  const email = `k039-${label}-${run}@example.com`
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, { method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken } })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  return { label, email, context, call }
}

const percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)]
const git = (...args) => execFileSync('git', args, { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).trim()

try {
  const holder = await account('titular')
  const operator = await account('operador')
  const establishment = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Chat K039 ${run}','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows[0].id
  await db.query('INSERT INTO memberships(user_id,establishment_id) SELECT id, $2 FROM users WHERE email = $1', [operator.email, establishment])
  const lotId = (await db.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
      longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K039', 'Panadería', 1, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '3 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [establishment])).rows[0].id
  const reserved = await holder.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)

  const confirmed = new Map()
  const failures = []
  const pages = {}
  for (const person of [holder, operator]) {
    const page = await person.context.newPage()
    page.on('pageerror', error => failures.push(`${person.label}: ${error.message}`))
    // Confirmación de guardado: el instante en que llega el 201 a quien envía.
    page.on('response', response => {
      if (response.request().method() !== 'POST' || !response.url().endsWith('/messages')) return
      const at = Date.now()
      if (response.status() !== 201) { failures.push(`${person.label}: envío ${response.status()}`); return }
      try { confirmed.set(response.request().postDataJSON().text, at) } catch { failures.push(`${person.label}: envío sin cuerpo`) }
    })
    await page.addInitScript(() => {
      window.__seen = {}
      new MutationObserver(() => {
        for (const item of document.querySelectorAll('.chat__messages li:not(.chat__mine) p')) window.__seen[item.textContent] ??= Date.now()
      }).observe(document, { childList: true, subtree: true, characterData: true })
    })
    await page.goto(`${baseUrl}/reservas/${reserved.body.id}/chat`)
    await page.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
    pages[person.label] = page
  }

  const texts = []
  const started = Date.now()
  for (let i = 0; i < MESSAGES; i++) {
    const fromOperator = i >= MESSAGES / 2
    const sender = pages[fromOperator ? 'operador' : 'titular']
    const text = `K039 latencia ${i + 1} ${run}`
    texts.push({ text, receiver: fromOperator ? 'titular' : 'operador' })
    const sent = sender.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'))
    await sender.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).fill(text)
    await sender.getByRole('button', { name: 'Enviar mensaje', exact: true }).click()
    await sent
    await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (i + 1) * INTERVAL_MS - Date.now())))
  }
  // El último mensaje tiene hasta tres veces la meta para aparecer antes de declararlo perdido.
  const deadline = Date.now() + 3 * GOAL_MS
  let seen = {}
  while (Date.now() < deadline) {
    seen = { titular: await pages.titular.evaluate(() => window.__seen), operador: await pages.operador.evaluate(() => window.__seen) }
    if (texts.every(({ text, receiver }) => seen[receiver][text])) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const delays = []
  const missing = []
  for (const { text, receiver } of texts) {
    if (confirmed.has(text) && seen[receiver][text]) delays.push(seen[receiver][text] - confirmed.get(text))
    else missing.push(text)
  }
  delays.sort((a, b) => a - b)
  const p95 = delays.length ? percentile(delays, 0.95) : null
  const result = {
    card: 'K039', script: 'api/scripts/test-web-chat-latency.mjs', anexo: 'H p. 19: chat visible P95 ≤ 7 s, al menos 100 mensajes',
    environment: { commit: git('rev-parse', 'HEAD'), dirtyTree: git('status', '--porcelain') !== '', os: `${os.type()} ${os.release()}`,
      cpu: `${os.cpus()[0].model} × ${os.cpus().length}`, memoryGb: Math.round(os.totalmem() / 1024 ** 3), node: `${process.version} ${process.arch}`,
      browser: `Chromium ${browser.version()} headless`, topology: 'Dos contextos de navegador en el mismo equipo que Vite, API, worker y PostgreSQL' },
    parameters: { messages: MESSAGES, intervalMs: INTERVAL_MS, order: 'la mitad del titular y después la mitad del operador; quien recibe no envía',
      polling: 'vista de K038: consulta cada 5 s con la vista visible' },
    observed: { n: delays.length, missing: missing.length, p50Ms: delays.length ? percentile(delays, 0.5) : null, p95Ms: p95,
      maxMs: delays.at(-1) ?? null, minMs: delays[0] ?? null, failures },
    goal: { indicator: 'Chat visible', goal: 'P95 ≤ 7000 ms', meetsGoal: p95 !== null && missing.length === 0 && p95 <= GOAL_MS },
  }
  const dir = fileURLToPath(new URL(`../.k039-results/${new URL(process.env.DATABASE_URL).pathname.slice(1)}/`, import.meta.url))
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}chat-visible.json`, JSON.stringify(result, null, 2))
  const s = value => value === null ? '-' : `${(value / 1000).toFixed(1)} s`
  console.log(`✓ chat visible: n=${delays.length}, p50 ${s(result.observed.p50Ms)}, p95 ${s(p95)}, max ${s(result.observed.maxMs)} `
    + `(meta P95 ≤ 7 s: ${result.goal.meetsGoal ? 'cumple' : 'no cumple'}); resultados en api/.k039-results/`)
  assert.deepEqual(failures, [], 'sin errores de página ni envíos rechazados')
  assert.equal(missing.length, 0, `mensajes sin confirmar o sin mostrar: ${missing.length}`)
} finally {
  await browser.close()
  await db.end()
}
