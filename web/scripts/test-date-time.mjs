import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDate, formatInstant, formatWindow } from '../src/format/date-time.ts'

test('fechas y horas con ceros, año completo, minutos y reloj 00–23', () => {
  assert.equal(formatInstant('2026-11-04T12:05:59Z', 'America/Santiago'), '04/11/2026 · 09:05')
  assert.equal(formatInstant('2026-11-04T03:00:00Z', 'America/Santiago'), '04/11/2026 · 00:00')
  assert.equal(formatInstant('2026-01-01T01:05:00Z', 'America/Santiago'), '31/12/2025 · 22:05')
})

test('zona explícita y horario de verano/invierno', () => {
  assert.equal(formatInstant('2026-07-04T12:05:00Z', 'America/Santiago'), '04/07/2026 · 08:05')
  assert.equal(formatInstant('2026-11-04T12:05:00Z', 'UTC'), '04/11/2026 · 12:05')
  assert.equal(formatInstant('2026-11-04T12:05:00Z', 'America/Punta_Arenas'), '04/11/2026 · 09:05')
})

test('fechas de calendario sin conversión y ventanas con cambio de día local', () => {
  assert.equal(formatDate('2026-01-01'), '01/01/2026')
  assert.equal(formatDate('2028-02-29'), '29/02/2028')
  assert.equal(formatWindow('2026-11-04T12:05:00Z', '2026-11-04T14:00:00Z', 'America/Santiago'), '04/11/2026 · 09:05 – 11:00')
  // Fechas UTC distintas, mismo día en Santiago.
  assert.equal(formatWindow('2026-11-04T23:00:00Z', '2026-11-05T01:00:00Z', 'America/Santiago'), '04/11/2026 · 20:00 – 22:00')
  assert.equal(formatWindow('2026-11-04T23:00:00Z', '2026-11-05T04:00:00Z', 'America/Santiago'), '04/11/2026 · 20:00 – 05/11/2026 · 01:00')
})
