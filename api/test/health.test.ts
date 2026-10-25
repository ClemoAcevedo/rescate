import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { createApp } from "../src/app.js"

test("GET /health responde 200 con el estado de la API", async () => {
  const server = createApp().listen(0, "127.0.0.1")
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

test("K036: la salud informa la base y el worker; sin base responde 503", async () => {
  const cases = [
    [{ database: "ok", worker: "ok" }, 200, "ok"],
    [{ database: "ok", worker: "stopped" }, 200, "ok"],
    [{ database: "unavailable", worker: "unknown" }, 503, "unavailable"],
  ] as const
  for (const [health, status, overall] of cases) {
    const server = createApp({ health: async () => health }).listen(0, "127.0.0.1")
    try {
      await once(server, "listening")
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`)
      assert.equal(response.status, status)
      assert.deepEqual(await response.json(), { status: overall, ...health })
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    }
  }
})
