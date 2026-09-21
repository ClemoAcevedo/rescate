import { createServer as createHttpsServer } from "node:https"
import { readFileSync } from "node:fs"
import { createApi } from "./composition.js"

const port = Number(process.env.PORT ?? 3000)
const certPath = process.env.TLS_CERT_FILE
const keyPath = process.env.TLS_KEY_FILE
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("TLS_CERT_FILE y TLS_KEY_FILE deben configurarse juntos")
const tls = certPath && keyPath ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined
const api = createApi()
// TLS directo para desarrollo/entornos simples; en despliegue puede terminar en
// un proxy HTTPS del mismo origen. Nunca se confía automáticamente en X-Forwarded-*.
const server = tls ? createHttpsServer(tls, api.app).listen(port) : api.app.listen(port)
server.once("listening", () => console.log(`API running on ${tls ? "HTTPS" : "HTTP"} port ${port}`))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => { void api.close().finally(() => process.exit(0)) })
  })
}
