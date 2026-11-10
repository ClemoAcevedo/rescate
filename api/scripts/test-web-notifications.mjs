import assert from 'node:assert/strict'
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from './support/browser.mjs'

// K030: bandeja de avisos contra Vite HTTPS → proxy → API → PostgreSQL, con el worker real
// generando los avisos del outbox. Requiere servicios iniciados (test:web:compose los levanta).
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API y el worker')
const password = 'K030-notifications-password'
const run = Date.now()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const ok = (message) => console.log(`✓ ${message}`)

/** Cuenta propia en su contexto; las cuentas se crean en secuencia (K008 limita scrypt a 2 a la vez). */
async function account(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport: { width: 1366, height: 768 } })
  contexts.push(context)
  const email = `k030-${label}-${run}@example.com`
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, { method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken } })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  return { context, call, email }
}

try {
  const establishment = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Avisos K030 ${run}','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows[0].id
  const lotId = (await db.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
      longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K030', 'Panadería', 1, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '3 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [establishment])).rows[0].id
  const ana = await account('ana')
  const bea = await account('bea')
  const cata = await account('cata')

  const reserved = await ana.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const entry = await bea.call('POST', `/public/lots/${lotId}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(entry.body.status, 'waiting')

  const page = await bea.context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const rateLimited = []
  page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })
  const inboxLink = page.getByRole('link', { name: /^Avisos/ })
  await page.goto(`${baseUrl}/reservas`)
  await inboxLink.waitFor()
  assert.equal(await inboxLink.getAttribute('aria-label'), 'Avisos')
  ok('sin avisos: la cabecera muestra «Avisos» sin contador')

  // Ana cancela: la oferta para Bea nace con la transición y el worker genera el aviso.
  assert.equal((await ana.call('POST', `/reservations/${reserved.body.id}/cancel`, {})).status, 200)
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 1 sin leer',
    null, { timeout: 25_000 })
  ok('la oferta emitida llega a la cabecera por la consulta periódica (≤ 15 s con la pestaña visible)')

  // Sin conexión, la oferta vence y otra persona reserva el pack liberado; al reconectar se recupera de inmediato.
  await bea.context.setOffline(true)
  await db.query(`UPDATE waitlist_entries SET offered_at = now() - interval '20 minutes',
    offer_expires_at = now() - interval '10 minutes' WHERE public_id = $1`, [entry.body.id])
  // Reservar asienta la cola bajo el bloqueo: registra el vencimiento de Bea y luego asigna el pack libre.
  const cataReservation = await cata.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(cataReservation.status, 201)
  await page.waitForTimeout(3_000)
  const reconnectedAt = Date.now()
  await bea.context.setOffline(false)
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 2 sin leer',
    null, { timeout: 10_000 })
  const recovered = Date.now() - reconnectedAt
  assert.ok(recovered < 10_000)
  ok(`desconectada: el aviso de vencimiento persiste y se recupera al reconectar (${recovered} ms)`)

  await inboxLink.click()
  await page.waitForURL(`${baseUrl}/avisos`)
  await page.getByText('2 avisos sin leer.').waitFor()
  const expiredCard = page.getByRole('article', { name: 'Tu oferta venció' })
  const offerCard = page.getByRole('article', { name: 'Tienes una oferta por 1 pack' })
  await expiredCard.getByText('Nuevo', { exact: true }).waitFor()
  await offerCard.getByText('Nuevo', { exact: true }).waitFor()
  assert.equal(await page.getByRole('article').count(), 2)
  ok('la bandeja lista oferta y vencimiento, ambos sin leer')

  for (const viewport of [{ width: 360, height: 800 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: `/tmp/rescate-k030-${viewport.width}x${viewport.height}.png`, fullPage: true })
  }
  ok('layout sin scroll horizontal en 360×800 y 1366×768')

  // Abrir el aviso de la oferta registra la lectura y lleva al estado vigente: vencida, sin aceptar.
  const read = page.waitForResponse((response) => /\/api\/notifications\/[^/]+\/read$/.test(new URL(response.url()).pathname))
  await offerCard.getByRole('button', { name: 'Ver oferta' }).click()
  assert.equal((await read).status(), 200)
  await page.waitForURL(`${baseUrl}/espera/${entry.body.id}`)
  await page.getByText('No puedes aceptar una oferta vencida').waitFor()
  assert.equal(await page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
  assert.equal((await db.query('SELECT status FROM waitlist_entries WHERE public_id = $1', [entry.body.id])).rows[0].status, 'expired')
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 1 sin leer')
  ok('leer el aviso de una oferta antigua no la reactiva: el detalle la muestra vencida y sin aceptar')

  await inboxLink.click()
  await page.getByText('1 aviso sin leer.').waitFor()
  assert.equal(await offerCard.getByText('Nuevo', { exact: true }).count(), 0)
  ok('al volver, la oferta figura leída y el contador baja a 1')

  // Cada persona ve solo sus avisos: Ana su cancelación; Cata reservó directo y no recibe avisos en K030.
  const anaPage = await ana.context.newPage()
  await anaPage.goto(`${baseUrl}/avisos`)
  await anaPage.getByRole('article', { name: 'Reserva cancelada' }).waitFor({ timeout: 20_000 })
  assert.equal(await anaPage.getByRole('article').count(), 1)
  const counts = await db.query(`SELECT kind, count(*)::int AS n FROM notifications n JOIN outbox_events e ON e.id = n.event_id
    WHERE (e.payload->'lot'->>'id') = $1 GROUP BY kind ORDER BY kind`, [lotId])
  assert.deepEqual(counts.rows, [{ kind: 'offer_expired', n: 1 }, { kind: 'offer_issued', n: 1 }, { kind: 'reservation_cancelled', n: 1 }])
  ok('cada bandeja muestra solo lo propio; un aviso por evento y destinatario')

  // K044: la bandeja existente debe poder recuperar los avisos del nuevo tipo.
  await db.query(`INSERT INTO memberships(user_id,establishment_id) SELECT id,$2 FROM users WHERE email=$1`, [ana.email, establishment])
  const incident = await cata.call('POST', `/lots/${lotId}/incidents`, { reason: 'Revisar el contenido', idempotencyKey: randomUUID() })
  assert.equal(incident.status, 201)
  const version = { action: 'publish', version: 0, reason: 'Problema de contenido. '.repeat(40),
    instructions: 'No consumir. Contactar al establecimiento.', closeLot: true, idempotencyKey: randomUUID() }
  const versionPath = `/incidents/${incident.body.id}/versions`
  assert.equal((await ana.call('POST', versionPath, { ...version, closeLot: 'true' })).status, 422)
  assert.equal((await bea.call('POST', versionPath, version)).status, 404)
  await bea.context.setOffline(true)
  const published = await ana.call('POST', versionPath, version)
  assert.equal(published.status, 201); assert.equal(published.body.lotClosed, true)
  assert.deepEqual((await ana.call('POST', versionPath, version)).body, published.body)
  assert.equal((await ana.call('POST', versionPath, { ...version, closeLot: false })).status, 409)
  await page.waitForTimeout(2500)
  await bea.context.setOffline(false)
  const incidentCard = page.getByRole('article', { name: 'Aviso de incidencia', exact: true })
  await incidentCard.waitFor({ timeout: 20000 })
  await incidentCard.getByText(/Tuviste un compromiso con este lote/).waitFor()
  await incidentCard.getByText(/No consumir\. Contactar al establecimiento/).waitFor()
  await incidentCard.getByText(/El lote está cerrado/).waitFor()
  for (const width of [360,1366]) {
    await page.setViewportSize({ width, height: 800 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  const incidentRead = page.waitForResponse(r => /\/api\/notifications\/[^/]+\/read$/.test(new URL(r.url()).pathname))
  await incidentCard.getByRole('button', { name: 'Marcar como leído' }).click()
  assert.equal((await incidentRead).status(), 200)
  assert.equal(await incidentCard.getByText('Nuevo', { exact: true }).count(), 0)
  const cataId = (await db.query('SELECT id FROM users WHERE email=$1', [cata.email])).rows[0].id
  const cataNotice = (await db.query(`SELECT n.public_id::text AS id FROM notifications n
    WHERE n.user_id=$1 AND n.kind='incident_version'`, [cataId])).rows[0].id
  assert.equal((await bea.call('POST', `/notifications/${cataNotice}/read`, {})).status, 404)
  assert.equal((await db.query('SELECT status FROM commitments WHERE public_id=$1', [cataReservation.body.id])).rows[0].status, 'cancelled')
  const resolved = await ana.call('POST', versionPath, { ...version, action: 'resolve', version: 1,
    reason: 'Problema atendido', instructions: 'La incidencia se ha resuelto.', closeLot: false, idempotencyKey: randomUUID() })
  assert.equal(resolved.status, 201); assert.equal(resolved.body.lotClosed, true)
  await page.reload()
  await page.getByRole('article', { name: 'Incidencia resuelta', exact: true }).waitFor({ timeout: 20000 })
  assert.equal((await db.query('SELECT status FROM lots WHERE public_id=$1', [lotId])).rows[0].status, 'withdrawn')
  // K045: historial y URL propias sobre las versiones reales publicadas arriba.
  await page.getByRole('link', { name: 'Ver historial de incidencias', exact: true }).click()
  await page.getByRole('heading', { name: 'Historial de incidencias', exact: true }).waitFor()
  await page.getByRole('article', { name: 'Aviso de incidencia', exact: true }).waitFor()
  assert.equal(await page.getByRole('article').count(), 2, 'el historial conserva la versión leída y la resuelta')
  const history = await bea.call('GET', '/notifications?kind=incident_version')
  const original = history.body.items.find(item => item.incident.version === 1)
  assert.ok(original.readAt)
  assert.equal((await bea.call('GET', `/notifications/${cataNotice}`)).status, 404)
  // El texto del chat ya pasó su retención; las instrucciones de la versión siguen disponibles.
  await db.query(`UPDATE lots SET pickup_starts_at=now()-interval '42 days', pickup_ends_at=now()-interval '41 days',
    closed_at=now()-interval '41 days' WHERE public_id=$1`, [lotId])
  await db.query(`UPDATE commitments SET ended_at=now()-interval '41 days' WHERE lot_id=(SELECT id FROM lots WHERE public_id=$1)`, [lotId])
  await db.query(`INSERT INTO chat_messages(commitment_id,author_user_id,sequence,idempotency_key,body,created_at)
    SELECT c.id,c.user_id,1,$2,NULL,now()-interval '42 days' FROM commitments c WHERE c.public_id=$1`,
    [cataReservation.body.id, randomUUID()])
  const retainedChat = await cata.call('GET', `/reservations/${cataReservation.body.id}/messages`)
  assert.equal(retainedChat.status, 200)
  assert.equal(retainedChat.body.open, false)
  assert.deepEqual(retainedChat.body.items, [])
  await page.goto(`${baseUrl}/incidencias/${original.id}`)
  await page.getByRole('heading', { name: 'Instrucciones', exact: true }).waitFor()
  await page.getByText('Sin entrega registrada al fijarse esta versión:', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Leído', exact: true }).waitFor()
  for (const width of [360,1366]) {
    await page.setViewportSize({ width, height: 800 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  const originalReadAt = (await bea.call('GET', `/notifications/${original.id}`)).body.readAt
  await page.reload()
  await page.getByRole('button', { name: 'Leído', exact: true }).waitFor()
  assert.equal((await bea.call('GET', `/notifications/${original.id}`)).body.readAt, originalReadAt)
  await page.goto(`${baseUrl}/incidencias/${cataNotice}`)
  await page.getByText('El aviso no existe o no pertenece a tu cuenta.', { exact: true }).waitFor()
  assert.equal(await page.locator('.incident-detail').count(), 0)
  // Titular con entrega acreditada: publicación real de otra incidencia, sin cerrar la entrega.
  const deliveredLot = (await db.query(`INSERT INTO lots (establishment_id,description,category,quantity,address,latitude,longitude,
    time_zone,pickup_starts_at,pickup_ends_at,status,published_at) VALUES ($1,'Lote con entrega K045','Prueba',1,
    'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',now()+interval '2 hours','published',now())
    RETURNING public_id::text AS id`, [establishment])).rows[0].id
  const deliveryReservation = await cata.call('POST', `/public/lots/${deliveredLot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  const code = (await cata.call('GET', `/reservations/${deliveryReservation.body.id}`)).body.pickupCode
  const pickup = await ana.call('POST', `/lots/${deliveredLot}/pickups`, { reservationId: deliveryReservation.body.id, code, idempotencyKey: randomUUID() })
  assert.equal(pickup.status, 201)
  const deliveredIncident = await cata.call('POST', `/lots/${deliveredLot}/incidents`, { reason: 'Problema tras entregar', idempotencyKey: randomUUID() })
  assert.equal((await ana.call('POST', `/incidents/${deliveredIncident.body.id}/versions`, {
    ...version, reason: 'Problema tras entregar', idempotencyKey: randomUUID(),
  })).status, 201)
  const cataPage = await cata.context.newPage()
  await cataPage.goto(`${baseUrl}/incidencias`)
  const deliveredCard = cataPage.getByRole('article', { name: 'Aviso de incidencia', exact: true }).filter({ hasText: 'Lote con entrega K045' })
  await deliveredCard.waitFor({ timeout: 20000 })
  await deliveredCard.getByRole('link', { name: 'Ver incidencia', exact: true }).click()
  await cataPage.getByText('Con entrega: recibiste packs', { exact: false }).waitFor()
  await cataPage.getByRole('button', { name: 'Marcar como leído', exact: true }).click()
  await cataPage.getByRole('button', { name: 'Leído', exact: true }).waitFor()
  await cataPage.getByText('No acredita que hayas cumplido las instrucciones.', { exact: false }).waitFor()
  ok('K045: historial de versiones reales, instrucciones tras retención del chat, primera lectura, privacidad y destinatario con entrega')

  ok('K044: cerrar por HTTP, reintentar, reconectar, leer instrucciones largas a 360/1366 px, privacidad y resolución sin reapertura')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [], 'la prueba no debe depender de respuestas 429')
  console.log('K030 web notifications: real API, worker, proxy, CSRF, polling, reconnect, read and permissions checks passed')

  if (process.env.MANUAL_INCIDENTS === '1') {
    console.log(`\nDemo manual K045 lista: ${baseUrl}/login?from=%2Fincidencias`)
    console.log(`Cuenta con entrega: ${cata.email}`)
    console.log(`Cuenta sin entrega: ${bea.email}`)
    console.log(`Contraseña de ambas cuentas: ${password}`)
    const ownNotice = (await cata.call('GET', '/notifications?kind=incident_version')).body.items
      .find(item => item.incident.id === deliveredIncident.body.id)
    console.log(`URL propia de la cuenta con entrega: ${baseUrl}/incidencias/${ownNotice.id}`)
    console.log('Con la cuenta sin entrega, esa URL debe rechazar el acceso.')
    console.log('Comandos: aviso (publica otra versión real para la cuenta con entrega) | salir.')
    console.log('Para reconexión: abre /avisos, activa Offline en DevTools, escribe aviso aquí y vuelve a Online.')
    let currentVersion = 1
    const input = createInterface({ input: process.stdin, output: process.stdout })
    input.on('SIGINT', () => input.close())
    try {
      for await (const line of input) {
        const command = line.trim()
        if (command === 'salir') break
        if (command !== 'aviso') { console.log('Comandos: aviso | salir'); continue }
        const updated = await ana.call('POST', `/incidents/${deliveredIncident.body.id}/versions`, {
          action: 'update', version: currentVersion, reason: 'Seguimiento de la incidencia para prueba manual',
          instructions: 'Nueva versión para comprobar recuperación al reconectar. Contactar al establecimiento.',
          closeLot: false, idempotencyKey: randomUUID(),
        })
        if (updated.status !== 201) { console.log(`No se pudo publicar la versión (${updated.status}).`); continue }
        currentVersion = updated.body.version
        console.log(`Versión ${currentVersion} publicada. El worker generará un aviso sin leer.`)
      }
    } finally { input.close() }
  }

} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
}
