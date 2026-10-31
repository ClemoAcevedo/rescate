import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createLotManagementRepository } from '../dist/infrastructure/postgres/lot-management-repository.js'
import { createLotManagement } from '../dist/application/lots/management.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { assertContract } from '../test/support/openapi.ts'
const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_e2_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada E2')
const db = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const directory = await mkdtemp(join(tmpdir(), 'rescate-e2-photos-'))
const api = createApi({ DATABASE_URL: connectionString, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64'),
  PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: directory, PHOTO_MAX_PER_LOT: '6' }, () => {})
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
function client() {
  let csrf = ''; const cookies = new Map()
  return async function call(method, path, body, overrides = {}, retry = 0) {
    const binary = body instanceof Uint8Array
    const response = await fetch(base + path, { method, headers: {
      Cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': binary ? 'image/png' : 'application/json' }),
      ...(method === 'GET' ? {} : { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }), ...overrides,
    }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)) }
    const result = await response.json(); if (result.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    if (response.status === 429 && retry < 3) {
      await new Promise(resolve=>setTimeout(resolve, Number(response.headers.get('retry-after'))*1000))
      return call(method,path,body,overrides,retry+1)
    }
    return { status: response.status, body: result }
  }
}
let count=0
const ok = label => console.log(`OK E2 ${++count}: ${label}`)
try {
  await db.connect()
  async function person() {
    const call = client(), email = `e2-${randomUUID()}@example.invalid`, password = 'Clave-segura-e2-fixture'
    await call('GET','/auth/session')
    assert.equal((await call('POST','/auth/register',{ email, password, privacyConsent:true })).status,201)
    assert.equal((await call('POST','/auth/login',{ email, password })).status,200)
    const user = (await db.query('SELECT id::text FROM users WHERE email=$1',[email])).rows[0]
    return { call, id: user.id }
  }
  const operator = await person(), buyer = await person(), waiting = await person(), stranger = await person()
  const est = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('E2','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text`)).rows[0]
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)',[operator.id,est.id])
  const makeLot = async quantity => (await db.query(`INSERT INTO lots(establishment_id,description,category,quantity,
    address,latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,published_at)
    VALUES ($1,'Berlines de prueba','E2',$2,'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',
      now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`,[est.id,quantity])).rows[0].id
  const lot = await makeLot(2), path = `/lots/${lot}/management`
  const input = (action, version, extra={}) => ({ action, version, reason: 'Operación de prueba E2', idempotencyKey: randomUUID(), ...extra })
  assert.equal((await client()('GET',path)).status,401)
  assert.equal((await stranger.call('GET',path)).status,403)
  assert.equal((await operator.call('POST',path,input('pause',1),{'X-CSRF-Token':'incorrecto'})).status,403)
  assert.equal((await operator.call('POST',path,{ ...input('pause',1), reason:' ' })).status,422)
  assert.equal((await operator.call('POST',path,input('pause',1),{'Content-Type':'text/plain'})).status,415)
  ok('sesión, permiso de establecimiento, CSRF, formato y motivo comprobados por HTTP real')
  const reduce = input('reduce_stock',1,{ quantity:1 })
  const responses = await Promise.all([operator.call('POST',path,reduce),operator.call('POST',path,reduce)])
  assert.deepEqual(responses.map(r=>r.status),[200,200]);assert.deepEqual(responses[0].body,responses[1].body)
  assert.equal(responses[0].body.freeQuantity,1);assert.equal(responses[0].body.unassignableQuantity,1)
  assert.equal((await buyer.call('GET',`/public/lots/${lot}`)).body.availableQuantity,1)
  assert.equal((await operator.call('POST',path,{...reduce,quantity:2})).status,409)
  assert.equal((await operator.call('POST',path,input('pause',1))).status,409)
  ok('dos berlines menos una venta local dejan uno; reintentos simultáneos no descuentan dos veces')
  const reserved = await buyer.call('POST',`/public/lots/${lot}/reservations`,{quantity:1,idempotencyKey:randomUUID()})
  assert.equal(reserved.status,201)
  assert.equal((await operator.call('POST',path,input('reduce_stock',2,{quantity:1}))).status,409)
  const entry = await waiting.call('POST',`/public/lots/${lot}/waitlist`,{quantity:1,idempotencyKey:randomUUID()})
  assert.equal(entry.status,201)
  const paused = await operator.call('POST',path,input('pause',2));assert.equal(paused.status,200);assert.equal(paused.body.paused,true)
  assert.equal((await buyer.call('GET',`/public/lots/${lot}`)).status,404)
  assert.equal((await stranger.call('POST',`/public/lots/${lot}/reservations`,{quantity:1,idempotencyKey:randomUUID()})).status,404)
  assert.equal((await stranger.call('POST',`/public/lots/${lot}/waitlist`,{quantity:1,idempotencyKey:randomUUID()})).status,404)
  assert.equal((await buyer.call('POST',`/reservations/${reserved.body.id}/cancel`,{})).status,200)
  assert.equal((await waiting.call('GET',`/waitlist/${entry.body.id}`)).body.status,'waiting')
  const resumed = await operator.call('POST',path,input('resume',3));assert.equal(resumed.status,200)
  assert.equal(resumed.body.offeredQuantity,1);assert.equal(resumed.body.freeQuantity,0)
  assert.equal((await waiting.call('GET',`/waitlist/${entry.body.id}`)).body.status,'offered')
  ok('pausa impide nuevas asignaciones; cancelación conserva la cola y reactivar ofrece en FIFO')
  const pausedOffer=await operator.call('POST',path,input('pause',4));assert.equal(pausedOffer.status,200)
  const accepted=await waiting.call('POST',`/waitlist/${entry.body.id}/accept`,{});assert.equal(accepted.status,200)
  const reservationId=accepted.body.reservationId
  const withdrawal=input('withdraw',5)
  const withdrawn=await operator.call('POST',path,withdrawal);assert.equal(withdrawn.status,200)
  assert.equal(withdrawn.body.status,'withdrawn');assert.equal(withdrawn.body.paused,false)
  assert.equal(withdrawn.body.freeQuantity+withdrawn.body.offeredQuantity+withdrawn.body.reservedQuantity,0)
  assert.equal(withdrawn.body.unassignableQuantity,2)
  const cancelled=await waiting.call('GET',`/reservations/${reservationId}`)
  assert.equal(cancelled.body.status,'cancelled');assert.equal(cancelled.body.pickupCode,null)
  assert.deepEqual((await operator.call('POST',path,withdrawal)).body,withdrawn.body)
  assert.equal((await db.query("SELECT count(*)::int n FROM outbox_events WHERE event_type='reservation_cancelled' AND payload->>'reservationId'=$1",[reservationId])).rows[0].n,1)
  ok('oferta emitida sigue aceptable durante pausa; retirar cancela, invalida códigos y avisa una sola vez')
  // Concurrencia real: una reserva y un descuento compiten por la misma última unidad.
  const raceLot=await makeLot(1), management=createLotManagement(createLotManagementRepository(pool))
  const race=await Promise.allSettled([
    management.command({userId:operator.id},raceLot,input('reduce_stock',1,{quantity:1})),
    stranger.call('POST',`/public/lots/${raceLot}/reservations`,{quantity:1,idempotencyKey:randomUUID()}),
  ])
  const counters=(await db.query('SELECT quantity,free_quantity,reserved_quantity,expired_quantity FROM lots WHERE public_id=$1',[raceLot])).rows[0]
  assert.equal(counters.free_quantity,0);assert.equal(counters.reserved_quantity+counters.expired_quantity,1)
  assert.equal(Number(race[0].status==='fulfilled')+Number(race[1].status==='fulfilled'&&race[1].value.status===201),1)
  ok('venta presencial contra reserva por la última unidad: un solo ganador, sin sobreasignación')
  // Cierre y entrega concurrentes: esperar a que ambos comandos estén bloqueados en PostgreSQL.
  const closingLot=await makeLot(2)
  const closingReservation=await buyer.call('POST',`/public/lots/${closingLot}/reservations`,{quantity:1,idempotencyKey:randomUUID()})
  const detail=await buyer.call('GET',`/reservations/${closingReservation.body.id}`)
  await db.query('BEGIN')
  await db.query('SELECT id FROM lots WHERE public_id=$1 FOR UPDATE',[closingLot])
  const closing=operator.call('POST',`/lots/${closingLot}/management`,input('withdraw',1))
  const pickup=operator.call('POST',`/lots/${closingLot}/pickups`,{reservationId:closingReservation.body.id,code:detail.body.pickupCode,idempotencyKey:randomUUID()})
  let blocked=0
  for(let i=0;i<100&&blocked<2;i++) {
    const observed=await pool.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%FROM public.lots WHERE public_id%'`)
    blocked=observed.rows[0].n
    if(blocked<2) await new Promise(resolve=>setTimeout(resolve,10))
  }
  await db.query('COMMIT')
  const [closed,picked]=await Promise.all([closing,pickup])
  assert.ok(blocked>=2,'ambos comandos esperaron el bloqueo real')
  assert.equal(closed.status,200);assert.ok([201,409].includes(picked.status))
  const finished=await management.get({userId:operator.id},closingLot)
  assert.equal(finished.deliveredQuantity,picked.status===201?1:0)
  assert.equal(finished.deliveredQuantity+finished.unassignableQuantity,2)
  assert.equal(finished.reservedQuantity,0)
  ok('retiro de publicación contra entrega: bloqueos observados, códigos invalidados y entregas previas conservadas')
  const expiredLot=await makeLot(1)
  await management.command({userId:operator.id},expiredLot,input('pause',1))
  await db.query("UPDATE lots SET pickup_starts_at=now()-interval '2 hours',pickup_ends_at=now()-interval '1 hour' WHERE public_id=$1",[expiredLot])
  await assert.rejects(management.command({userId:operator.id},expiredLot,input('resume',2)),/closed/)
  const expiries=createExpiryUseCases(createLotExpiryRepository(pool),()=>{})
  assert.equal((await expiries.expireLot(expiredLot)).lotClosed,true)
  const expired=await management.get({userId:operator.id},expiredLot)
  assert.equal(expired.status,'expired');assert.equal(expired.paused,false);assert.equal(expired.unassignableQuantity,1)
  ok('un lote pausado también vence; reactivar no extiende el plazo')
  // Un fallo posterior a escribir también revierte el historial y la intención.
  const rollbackLot=await makeLot(2), repository=createLotManagementRepository(pool)
  const failing=createLotManagement({ ...repository,
    withCommand: (user,lot,key,operate)=>repository.withCommand(user,lot,key,(state,writer)=>operate(state,{
      ...writer, apply:async(...args)=>{await writer.apply(...args);throw new Error('fallo posterior al historial')},
    })),
  })
  const rollbackIntent=input('reduce_stock',1,{quantity:1})
  await assert.rejects(failing.command({userId:operator.id},rollbackLot,rollbackIntent),/fallo posterior/)
  const untouched=await management.get({userId:operator.id},rollbackLot)
  assert.equal(untouched.freeQuantity,2);assert.equal(untouched.version,1);assert.equal(untouched.history.length,0)
  const recovered=await management.command({userId:operator.id},rollbackLot,rollbackIntent)
  assert.equal(recovered.freeQuantity,1);assert.equal(recovered.history.length,1)
  ok('fallo tras escribir revierte stock, versión, historial e intención; la misma clave se recupera')
  // Una oferta que vence durante la pausa libera F sin adelantar a la siguiente persona.
  const pausedQueue=await makeLot(1)
  const held=await buyer.call('POST',`/public/lots/${pausedQueue}/reservations`,{quantity:1,idempotencyKey:randomUUID()})
  const first=await waiting.call('POST',`/public/lots/${pausedQueue}/waitlist`,{quantity:1,idempotencyKey:randomUUID()})
  const second=await stranger.call('POST',`/public/lots/${pausedQueue}/waitlist`,{quantity:1,idempotencyKey:randomUUID()})
  await buyer.call('POST',`/reservations/${held.body.id}/cancel`,{})
  await management.command({userId:operator.id},pausedQueue,input('pause',1))
  await db.query(`UPDATE waitlist_entries SET offered_at=now()-interval '11 minutes',offer_expires_at=now()-interval '1 minute'
    WHERE public_id=$1`,[first.body.id])
  await expiries.expireLot(pausedQueue)
  const inPause=await management.get({userId:operator.id},pausedQueue)
  assert.equal(inPause.freeQuantity,1);assert.equal(inPause.offeredQuantity,0);assert.equal(inPause.unassignableQuantity,0)
  assert.equal((await stranger.call('GET',`/waitlist/${second.body.id}`)).body.status,'waiting')
  await management.command({userId:operator.id},pausedQueue,input('resume',2))
  assert.equal((await stranger.call('GET',`/waitlist/${second.body.id}`)).body.status,'offered')
  const third=await operator.call('POST',`/public/lots/${pausedQueue}/waitlist`,{quantity:1,idempotencyKey:randomUUID()})
  assert.equal(third.status,201)
  await management.command({userId:operator.id},pausedQueue,input('withdraw',3))
  for(const entryId of [second.body.id,third.body.id]) {
    const ended=(await db.query('SELECT status,ended_at FROM waitlist_entries WHERE public_id=$1',[entryId])).rows[0]
    assert.equal(ended.status,'expired');assert.ok(ended.ended_at)
  }
  assert.equal((await management.get({userId:operator.id},pausedQueue)).unassignableQuantity,1)
  ok('oferta vencida durante pausa conserva la cola; retiro termina tanto ofertas como espera')
  // Configuración >3 aplicada tanto por API como por el esquema SQL.
  const draft=await makeLot(1)
  await db.query("UPDATE lots SET status='draft',published_at=NULL WHERE public_id=$1",[draft])
  const png=await readFile(new URL('../fixtures/k005.png',import.meta.url))
  for(let i=0;i<4;i++) assert.equal((await operator.call('POST',`/lots/${draft}/photos`,png)).status,202)
  const photos=await operator.call('GET',`/lots/${draft}/photos`)
  assert.equal(photos.body.limit,6);assert.deepEqual(photos.body.items.map(x=>x.position),[1,2,3,4])
  ok('cupo de seis comunicado a la web; cuarta foto admitida y persistida')
  const totals=await db.query(`SELECT id FROM lots WHERE quantity <> free_quantity+offered_quantity+reserved_quantity+delivered_quantity+expired_quantity
    OR free_quantity<0 OR reserved_quantity<0 OR expired_quantity<0`)
  assert.equal(totals.rows.length,0)
  console.log(`PASS E2: ${count} grupos con PostgreSQL real y contrato HTTP`)
} finally {
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
  await api.close();await pool.end();await db.end();await rm(directory,{recursive:true,force:true})
}
