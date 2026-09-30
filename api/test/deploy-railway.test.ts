import assert from "node:assert/strict"
import { test } from "node:test"

// El script operativo es JS; se prueban estados de la plataforma sin desplegar.
// @ts-expect-error El módulo mjs no necesita declaraciones para su uso por Node.
import { waitForDeployment } from "../scripts/deploy-railway.mjs"

test("CD espera el deploy que acaba de subir aunque otro ya esté saludable", async () => {
  let attempts = 0
  const result = await waitForDeployment("new", async () => {
    attempts++
    return [{ id: "old", status: "SUCCESS" }, { id: "new", status: attempts === 3 ? "SUCCESS" : "DEPLOYING" }]
  }, async () => {}, 4)
  assert.equal(result.id, "new")
  assert.equal(attempts, 3)
})

test("CD interrumpe ante migración/build/arranque fallido o falta de confirmación", async () => {
  for (const status of ["FAILED", "CRASHED", "REMOVED", "SKIPPED", "CANCELED"]) {
    await assert.rejects(waitForDeployment("new", async () => [{ id: "new", status }], async () => {}, 2), new RegExp(status))
  }
  await assert.rejects(waitForDeployment("new", async () => [{ id: "old", status: "SUCCESS" }], async () => {}, 2), /no confirmó SUCCESS/)
})
