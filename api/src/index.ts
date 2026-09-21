import { createApi } from "./composition.js"

const port = Number(process.env.PORT ?? 3000)
const api = createApi()

const server = api.app.listen(port, () => {
  console.log(`API running on port ${port}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void api.close().finally(() => process.exit(0))
    })
  })
}
