import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { app } from "../src/app.js"

test("GET /health responde 200 con el estado de la API", async () => {
  const server = app.listen(0, "127.0.0.1")
  try {
    await once(server, "listening")
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/health`)

    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    assert.deepEqual(await response.json(), { status: "ok" })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})
