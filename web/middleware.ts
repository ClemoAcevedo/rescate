/// <reference types="node" />
import { ipAddress, next } from '@vercel/functions'

export const config = { matcher: '/api/:path*', runtime: 'nodejs' }

/** La IP se lee dentro del runtime Vercel, antes del rewrite externo a Railway. */
export default async function middleware(request: Request): Promise<Response> {
  const ip = ipAddress(request)
  const secret = process.env.API_PROXY_SECRET
  if (!ip || !secret) return Response.json({ error: {
    code: 'SERVICE_UNAVAILABLE', message: 'El servicio no está disponible temporalmente.', requestId: null,
  } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  const headers = new Headers(request.headers)
  const timestamp = Date.now().toString()
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${ip}`)))
  const signature = btoa(String.fromCharCode(...signed)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  headers.set('x-rescate-client-ip', ip)
  headers.set('x-rescate-client-ip-signature', `${timestamp}.${signature}`)
  return next({ request: { headers } })
}
