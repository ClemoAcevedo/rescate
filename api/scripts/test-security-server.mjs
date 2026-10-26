// K034: API real en un proceso propio, para que la suite pueda reiniciarla y leer sus registros.
// Solo arranca bajo test-security.mjs (IPC) y contra una base aislada K034.
import { createApi } from '../dist/composition.js'

let database = ''
// Sin imprimir la URL si está mal formada: puede traer la contraseña.
try { database = new URL(process.env.DATABASE_URL).pathname.slice(1) } catch { database = '' }
if (!process.send || !/^rescate_k034_test_/.test(database)) throw new Error('Solo pruebas aisladas K034 vía IPC')
const api = createApi(process.env)
const server = api.app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.once('SIGTERM', () => {
  server.close(() => { void api.close().then(() => process.exit(0), () => process.exit(1)) })
  server.closeAllConnections()
})
