import { Router } from "express"
import type { Request, Response } from "express"
import type { IdentityUseCases } from "../application/identity/use-cases.js"
import { IdentityError } from "../application/identity/errors.js"
import { CSRF_COOKIE, SESSION_COOKIE, readCookie, setCookie } from "./authentication.js"
import type { Authentication } from "./authentication.js"
import type { createTrafficLimits } from "./rate-limits.js"
import { handleError, sendError } from "./errors.js"
import type { HttpSchemas } from "./openapi.js"

function credentials(value: unknown): HttpSchemas["LoginRequest"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityError("invalid_input", [""])
  const body = value as Record<string, unknown>
  const invalid = Object.keys(body).filter(k => k !== "email" && k !== "password")
  if (typeof body.email !== "string" || !body.email.length) invalid.push("email")
  if (typeof body.password !== "string") invalid.push("password")
  if (invalid.length) throw new IdentityError("invalid_input", invalid)
  return { email: body.email as string, password: body.password as string }
}
export function createAuthRouter(useCases: IdentityUseCases, auth: Authentication, limits: ReturnType<typeof createTrafficLimits>) {
  const router = Router()
  const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await handler(req, res) } catch (error) { handleError(error, res, console.error) }
  }
  router.get("/auth/session", run(async (req, res) => {
    const context = await auth.resolve(req)
    const session = context ? await useCases.describeSession(context) : null
    const body: HttpSchemas["SessionResponse"] = { session, csrfToken: auth.csrfToken(req, res, context) }
    res.json(body)
  }))
  for (const operation of ["register", "login"] as const) router.post(`/auth/${operation}`, run(async (req, res) => {
    auth.requireOrigin(req)
    if (operation === "login") limits.login(req.ip ?? req.socket.remoteAddress ?? "unknown")
    auth.requireCsrf(req, await auth.resolve(req))
    if (!req.is("application/json")) { sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere application/json."); return }
    const { email, password } = credentials(req.body)
    if (operation === "register") {
      const user = await useCases.register(email, password)
      const body: HttpSchemas["RegisterResponse"] = { user: { id: user.publicId, email: user.email } }
      res.status(201).json(body)
    } else {
      const result = await useCases.login(email, password, readCookie(req, SESSION_COOKIE))
      const session = await useCases.describeSession(result.context)
      setCookie(res, SESSION_COOKIE, result.secret)
      const body: HttpSchemas["LoginResponse"] = { session, csrfToken: auth.csrfToken(req, res, result.context, true) }
      res.json(body)
    }
  }))
  router.post("/auth/logout", run(async (req, res) => {
    const context = await auth.resolve(req)
    if (!context) throw new IdentityError("no_session")
    auth.requireOrigin(req); auth.requireCsrf(req, context)
    await useCases.logout(context)
    setCookie(res, SESSION_COOKIE, "", 0); setCookie(res, CSRF_COOKIE, "", 0)
    res.status(204).end()
  }))
  return router
}
