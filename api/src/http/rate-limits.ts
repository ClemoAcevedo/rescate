// Límites de tráfico por proceso (E1 H). Los fallos por cuenta viven en PostgreSQL.
export class TrafficLimitError extends Error {
  constructor(readonly retryAfter: number) { super("Límite temporal de solicitudes") }
}
export class TrafficCapacityError extends Error {}
export function createTrafficLimits(now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number; fullAt: number }>()
  const attempts = new Map<string, number[]>()
  const maximumKeys = 10000
  let nextCleanup = 0
  function cleanup(time: number) {
    if (time < nextCleanup) return
    nextCleanup = time + 60000
    for (const [key, value] of buckets) if (value.fullAt <= time) buckets.delete(key)
    for (const [key, value] of attempts) if (value.at(-1)! <= time - 900000) attempts.delete(key)
  }
  function bucket(key: string, rate: number, burst: number) {
    const time = now(); cleanup(time)
    const entry = buckets.get(key)
    const available = entry ? Math.min(burst, entry.tokens + Math.max(0, time - entry.at) * rate / 60000) : burst
    if (available < 1) throw new TrafficLimitError(Math.max(1, Math.ceil((1 - available) * 60 / rate)))
    if (!entry && buckets.size >= maximumKeys) throw new TrafficCapacityError()
    const tokens = available - 1
    buckets.set(key, { tokens, at: time, fullAt: time + (burst - tokens) * 60000 / rate })
  }
  return {
    ip: (ip: string) => bucket(`ip:${ip}`, 3000, 100),
    user: (id: string) => bucket(`user:${id}`, 120, 20),
    login(ip: string) {
      const time = now(); cleanup(time)
      const recent = (attempts.get(ip) ?? []).filter(at => at > time - 900000)
      if (recent.length >= 30) throw new TrafficLimitError(Math.max(1, Math.ceil((recent[0]! + 900000 - time) / 1000)))
      if (!attempts.has(ip) && attempts.size >= maximumKeys) throw new TrafficCapacityError()
      attempts.set(ip, [...recent, time])
    },
  }
}
