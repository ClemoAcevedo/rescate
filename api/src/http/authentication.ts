import type { Request, Response } from "express"
import type { IdentityUseCases, SessionContext } from "../application/identity/use-cases.js"
import { notAuthorized } from "../application/errors.js"
import { SESSION_DURATION_MS } from "../domain/identity.js"
import type { Authenticate } from "./actor.js"
import type { createTrafficLimits } from "./rate-limits.js"

export const SESSION_COOKIE = "__Host-rescate_session"
export const CSRF_COOKIE = "__Host-rescate_csrf"
const attributes = "; Path=/; HttpOnly; Secure; SameSite=Lax"
export function setCookie(res: Response, name: string, value: string, maxAge = 43200) {
  res.append("Set-Cookie", `${name}=${value}; Max-Age=${maxAge}${attributes}`)
}
export function readCookie(req: Request, name: string): string | undefined {
  const values = (req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`))
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined
}
interface CsrfTokens {
  issue(binding: string, expiresAt: number): string
  valid(token: string, binding: string, now: number, maximumExpiry: number): boolean
}
export function createAuthentication(useCases: IdentityUseCases, csrf: CsrfTokens, origins: Set<string>,
  limits: ReturnType<typeof createTrafficLimits>, now: () => number = Date.now) {
  const resolved = new WeakMap<Request, Promise<SessionContext | null>>()
  async function resolve(req: Request) {
    let pending = resolved.get(req)
    if (!pending) {
      pending = useCases.resolveSession(readCookie(req, SESSION_COOKIE)).then(context => {
        if (context) limits.user(context.user.id)
        return context
      })
      resolved.set(req, pending)
    }
    return pending
  }
  const binding = (context: SessionContext | null) => context ? `session:${context.session.id}` : "anonymous"
  const expiry = (context: SessionContext | null) => context?.session.expiresAt.getTime() ?? now() + SESSION_DURATION_MS
  function requireOrigin(req: Request) {
    const origin = req.header("origin")
    if (!origin || !origins.has(origin)) throw notAuthorized()
  }
  function requireCsrf(req: Request, context: SessionContext | null) {
    const cookie = readCookie(req, CSRF_COOKIE)
    if (!cookie || cookie !== req.header("x-csrf-token") || !csrf.valid(cookie, binding(context), now(), expiry(context))) throw notAuthorized()
  }
  function csrfToken(req: Request, res: Response, context: SessionContext | null, rotate = false) {
    const old = readCookie(req, CSRF_COOKIE)
    if (!rotate && old && csrf.valid(old, binding(context), now(), expiry(context))) return old
    const token = csrf.issue(binding(context), expiry(context))
    setCookie(res, CSRF_COOKIE, token)
    return token
  }
  const authenticate: Authenticate = async req => {
    const context = await resolve(req)
    return context ? { userId: context.user.id } : null
  }
  return { resolve, authenticate, requireOrigin, requireCsrf, csrfToken,
    async protectCommand(req: Request) { requireOrigin(req); requireCsrf(req, await resolve(req)) },
  }
}
export type Authentication = ReturnType<typeof createAuthentication>
