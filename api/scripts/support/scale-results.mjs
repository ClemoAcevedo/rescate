export const OPS = { e2: ['busqueda', 'reserva', 'cancelacion'], e3: ['busqueda', 'chat', 'bandeja', 'reserva', 'cancelacion', 'mensaje'] }
export const GOALS = { busqueda: 1000, reserva: 1500 }

export const deltas = `SELECT (SELECT count(*) FROM commitments)::int reservations,
  (SELECT count(*) FROM commitments WHERE status = 'cancelled')::int cancellations, (SELECT count(*) FROM chat_messages)::int messages`

// RNF01 (anexo H p. 19): ninguna tolerancia. Cada consulta cuenta filas que violan la regla.
const INVARIANTS = [
  ['inventario', 'Q = F + O + R + E + X sin cantidades negativas en todos los lotes',
    `SELECT count(*)::int n FROM lots WHERE quantity <> free_quantity + offered_quantity + reserved_quantity + delivered_quantity
      + expired_quantity OR LEAST(free_quantity, offered_quantity, reserved_quantity, delivered_quantity, expired_quantity) < 0`],
  ['conciliación', 'R y O de cada lote coinciden con sus reservas confirmadas y ofertas vigentes',
    `SELECT count(*)::int n FROM lots l
      LEFT JOIN (SELECT lot_id, sum(quantity) r FROM commitments WHERE status = 'confirmed' GROUP BY lot_id) c ON c.lot_id = l.id
      LEFT JOIN (SELECT lot_id, sum(offered_quantity) o FROM waitlist_entries WHERE status = 'offered' GROUP BY lot_id) w ON w.lot_id = l.id
      WHERE l.reserved_quantity <> COALESCE(c.r, 0) OR l.offered_quantity <> COALESCE(w.o, 0)`],
  ['entregas', 'Como máximo una entrega por compromiso',
    'SELECT count(*)::int n FROM (SELECT commitment_id FROM deliveries GROUP BY commitment_id HAVING count(*) > 1) d'],
  ['secuencias', 'Secuencias de chat contiguas desde 1 y sin duplicados por compromiso',
    `SELECT count(*)::int n FROM (SELECT commitment_id FROM chat_messages GROUP BY commitment_id
      HAVING min(sequence) <> 1 OR max(sequence) <> count(*) OR count(DISTINCT sequence) <> count(*)) s`],
  ['outbox fallido', 'Sin eventos del outbox en error', `SELECT count(*)::int n FROM outbox_events WHERE status = 'failed'`],
  ['outbox pendiente', 'Sin eventos pendientes tras esperar al worker', `SELECT count(*)::int n FROM outbox_events WHERE status = 'pending'`],
  ['avisos', 'Cada evento procesado tiene su aviso', `SELECT count(*)::int n FROM outbox_events e WHERE e.status = 'processed'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id AND n.user_id = e.recipient_user_id)`],
]

// Una escritura incierta para k6 (sin respuesta, 5xx o 2xx inválido) pudo confirmarse en la base:
// el delta queda entre los éxitos y los éxitos más las inciertas, que ya cuentan como errores.
export async function checkInvariants(db, baseline, successes, uncertain) {
  const results = []
  for (const [name, rule, text] of INVARIANTS) {
    const value = (await db.query(text)).rows[0].n
    results.push({ name, rule, value, expected: 0, ok: value === 0 })
  }
  const after = (await db.query(deltas)).rows[0]
  for (const [name, rule, key, op] of [['reservas nuevas', 'Compromisos nuevos = reservas exitosas de k6', 'reservations', 'reserva'],
    ['cancelaciones nuevas', 'Cancelaciones nuevas = cancelaciones exitosas de k6', 'cancellations', 'cancelacion'],
    ['mensajes nuevos', 'Mensajes nuevos = envíos exitosos de k6', 'messages', 'mensaje']]) {
    const value = after[key] - baseline[key]
    const [low, high] = [successes[op] ?? 0, (successes[op] ?? 0) + (uncertain[op] ?? 0)]
    results.push({ name, rule, value, expected: low === high ? low : `${low} a ${high} (${high - low} inciertas)`, ok: value >= low && value <= high })
  }
  return results
}

export const values = (summary, name) => summary?.metrics?.[name]?.values ?? {}
// Sin muestras k6 informa ceros: una latencia o una tasa vacía no cumple ninguna meta.
// `con_inesperados` suma a los éxitos los errores inesperados (sin respuesta = 10 s): es el P95 de las metas.
export const latency = (summary, op, phase, suffix = '') => {
  const trend = values(summary, `k032_${op}${suffix}{fase:${phase}}`)
  return trend.count ? trend : {}
}
export const errorsOf = (summary, op, phase) => {
  const rate = values(summary, `k032_errores{op:${op},fase:${phase}}`)
  const total = (rate.passes ?? 0) + (rate.fails ?? 0)
  return { total, unexpected: rate.passes ?? 0, rate: total ? rate.passes / total : undefined }
}

/** Cumple / no cumple por meta del anexo H p. 19 y validez del ensayo. */
export function evaluate(trial, mix = 'e3') {
  const ops = OPS[mix]
  const { summary, invariants } = trial
  const p95 = op => latency(summary, op, 'medida', '_con_inesperados')['p(95)']
  const successP95 = op => latency(summary, op, 'medida')['p(95)']
  const errorRate = op => errorsOf(summary, op, 'medida').rate
  const expected = ops.reduce((total, op) => total + (values(summary, `k032_esperados{op:${op},fase:medida}`).count ?? 0), 0)
  return [
    ...Object.entries(GOALS).map(([op, limit]) => ({ goal: `${op === 'busqueda' ? 'Búsqueda' : 'Reserva'} P95 ≤ ${limit} ms`,
      measured: p95(op) === undefined ? 'sin muestras' : `${fmt(p95(op))} ms (solo éxitos ${fmt(successP95(op))} ms)`,
      ok: p95(op) !== undefined && p95(op) <= limit })),
    { goal: 'Errores inesperados < 1 % por operación', measured: ops.map(op => `${op} ${fmt((errorRate(op) ?? NaN) * 100, 2)} %`).join(', '),
      ok: ops.every(op => errorRate(op) !== undefined && errorRate(op) < 0.01) },
    { goal: 'Sin iteraciones descartadas', measured: String(values(summary, 'dropped_iterations').count ?? 'sin dato'),
      ok: Boolean(summary?.metrics?.iterations) && (values(summary, 'dropped_iterations').count ?? 0) === 0 },
    { goal: 'Consistencia tras la carga (invariantes)', measured: `${invariants.filter(item => !item.ok).length} invariantes con falla`,
      ok: invariants.length > 0 && invariants.every(item => item.ok) },
    { goal: 'Validez del ensayo: 0 rechazos esperados en la fase medida', measured: String(expected), ok: summary !== null && expected === 0 },
  ]
}

export const fmt = (value, digits = 1) => value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits).replace('.', ',')

