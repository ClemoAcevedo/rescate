// Límites de tráfico por proceso (E1 H p. 21). Los fallos por cuenta y por operador viven en PostgreSQL.
import type { Request } from "express"

/** Origen de la solicitud: el socket. Sin `trust proxy`, X-Forwarded-For no lo cambia. */
export const clientAddress = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown"

export class TrafficLimitError extends Error {
  constructor(readonly retryAfter: number) { super("Límite temporal de solicitudes") }
}
export class TrafficCapacityError extends Error {}
export function createTrafficLimits(now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number; fullAt: number }>()
  const windows = new Map<string, { times: number[]; ms: number }>()
  const maximumKeys = 10000
  let nextCleanup = 0
  function cleanup(time: number) {
    if (time < nextCleanup) return
    nextCleanup = time + 60000
    for (const [key, value] of buckets) if (value.fullAt <= time) buckets.delete(key)
    for (const [key, value] of windows) if (value.times.at(-1)! <= time - value.ms) windows.delete(key)
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
  /** Ventana móvil: como máximo `limit` intentos dentro de los últimos `ms`. */
  function slidingWindow(key: string, limit: number, ms: number) {
    const time = now(); cleanup(time)
    const recent = (windows.get(key)?.times ?? []).filter(at => at > time - ms)
    if (recent.length >= limit) throw new TrafficLimitError(Math.max(1, Math.ceil((recent[0]! + ms - time) / 1000)))
    if (!windows.has(key) && windows.size >= maximumKeys) throw new TrafficCapacityError()
    windows.set(key, { times: [...recent, time], ms })
  }
  return {
    ip: (ip: string) => bucket(`ip:${ip}`, 3000, 100),
    user: (id: string) => bucket(`user:${id}`, 120, 20),
    /** Lecturas autenticadas (GET y HEAD): cupo propio para navegar el panel sin gastar el de escrituras (ADR 0014). */
    userRead: (id: string) => bucket(`user-read:${id}`, 300, 60),
    login: (ip: string) => slidingWindow(`login:${ip}`, 30, 900000),
    /** Revisar o confirmar un código de retiro (K034): 30 por IP cada minuto, cobrado tras el permiso. */
    pickupCode: (ip: string) => slidingWindow(`pickup-code:${ip}`, 30, 60000),
    /** Enviar un mensaje de chat: 12 por minuto y usuario, ráfaga 3. */
    message: (id: string) => bucket(`message:${id}`, 12, 3),
  }
}
