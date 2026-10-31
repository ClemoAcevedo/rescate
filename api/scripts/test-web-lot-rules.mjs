// Pruebas aisladas de reglas del cliente, ejecutadas en su runtime de navegador.
// El documento de prueba solo importa los módulos: no usa React, API ni PostgreSQL.
import assert from 'node:assert/strict'
import { chromium } from './support/browser.mjs'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ timezoneId: 'Asia/Tokyo' })
  const base = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  await page.route('**/__unit-lots', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reglas de lotes</title>' }))
  await page.goto(`${base}/__unit-lots`)
  const times = await page.evaluate(async () => {
    const { localInputToInstant, instantToLocalInput } = await import('/src/lots/lot-time.ts')
    return {
      winter: localInputToInstant('2026-07-15T09:30', 'America/Santiago'),
      summer: localInputToInstant('2026-01-15T09:30', 'America/Santiago'),
      fractional: localInputToInstant('2026-01-15T09:30', 'Asia/Kathmandu'),
      roundTrip: instantToLocalInput('2026-07-15T13:30:00Z', 'America/Santiago'),
      browserZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  })
  assert.deepEqual(times, { winter: '2026-07-15T09:30:00-04:00', summer: '2026-01-15T09:30:00-03:00',
    fractional: '2026-01-15T09:30:00+05:45', roundTrip: '2026-07-15T09:30', browserZone: 'Asia/Tokyo' })
  console.log('PASS regla web 1: ventana en la zona del lote, independiente del navegador; offset estacional y fraccionario')

  const invalid = await page.evaluate(async () => {
    const { localInputToInstant } = await import('/src/lots/lot-time.ts')
    return ['2026-02-30T10:00', '2026-01-15T24:30', 'fecha'].map(value => localInputToInstant(value, 'America/Santiago'))
      .concat([localInputToInstant('2024-03-10T02:30', 'America/New_York'),
        localInputToInstant('2026-01-15T10:00', 'zona-inexistente'),
        localInputToInstant('2024-02-29T10:00', 'UTC')])
  })
  assert.deepEqual(invalid, [null, null, null, null, null, '2024-02-29T10:00:00+00:00'])
  console.log('PASS regla web 2: calendario, año bisiesto y hora inexistente por cambio de horario')

  const forms = await page.evaluate(async () => {
    const { buildDescription, changedFields, lotValues, hasUnsavedChanges, acceptInteger } = await import('/src/lots/lot-form.ts')
    const values = { description: 'Pack de pan', category: 'Panadería', quantity: '2', conditions: '  ', address: 'Calle ficticia 123',
      latitude: '0', longitude: '0', timeZone: 'America/Santiago', pickupStartsAt: '2026-01-15T15:00', pickupEndsAt: '2026-01-15T16:00' }
    const built = buildDescription(values)
    const description = built.description
    const saved = { ...description, pickupStartsAt: '2026-01-15T18:00:00Z', pickupEndsAt: '2026-01-15T19:00:00Z' }
    return { valid: description !== undefined, zeroCoordinates: [description?.latitude, description?.longitude], conditions: description?.conditions,
      invalidQuantity: [0, -1, 1.5].map(quantity => Boolean(buildDescription({ ...values, quantity: String(quantity) }).errors?.quantity)),
      invalidWindow: Boolean(buildDescription({ ...values, pickupEndsAt: values.pickupStartsAt }).errors?.pickupEndsAt),
      invalidLatitude: Boolean(buildDescription({ ...values, latitude: '91' }).errors?.latitude),
      rejectedDecimal: acceptInteger('1.5'), same: changedFields(description, saved), changed: changedFields({ ...description, quantity: 3 }, saved),
      dirty: [hasUnsavedChanges(lotValues(saved), saved), hasUnsavedChanges({ ...lotValues(saved), quantity: '3' }, saved)] }
  })
  assert.equal(forms.valid, true)
  assert.deepEqual(forms.zeroCoordinates, [0, 0])
  assert.equal(forms.conditions, null)
  assert.deepEqual(forms.invalidQuantity, [true, true, true])
  assert.equal(forms.invalidWindow, true)
  assert.equal(forms.invalidLatitude, true)
  assert.equal(forms.rejectedDecimal, null)
  console.log('PASS regla web 3: packs enteros positivos, coordenada cero válida, rango y cierre posterior al inicio')
  assert.deepEqual(forms.same, {})
  assert.deepEqual(forms.changed, { quantity: 3 })
  assert.deepEqual(forms.dirty, [false, true])
  console.log('PASS regla web 4: mismo instante con otro offset no cambia el lote; PATCH mínimo y detección de cambios sin guardar')
} finally { await browser.close() }
