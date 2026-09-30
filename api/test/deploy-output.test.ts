import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parse } from "yaml"

// Ejecutar el parser del workflow: el formato plano de Actions provocó el fallo real.
const workflow = parse(readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8"))
const run = workflow.jobs.web.steps.find((step: { id?: string }) => step.id === "deploy").run as string
const parser = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1]
assert.ok(parser, "El workflow debe conservar un parser JSON verificable")

function readOutput(payload: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "rescate-vercel-output-"))
  const output = join(directory, "github-output")
  try {
    writeFileSync(join(directory, "deployment.json"), JSON.stringify(payload))
    writeFileSync(output, "")
    const processResult = spawnSync(process.execPath, ["--input-type=module"], {
      input: parser, cwd: directory, encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    })
    return { status: processResult.status, stderr: processResult.stderr, output: readFileSync(output, "utf8") }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

const deployment = { id: "dpl_smoke", readyState: "READY", url: "https://rescate-ci.vercel.app" }

test("El workflow acepta el JSON plano que Vercel devuelve en Actions", () => {
  const result = readOutput(deployment)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, "url=https://rescate-ci.vercel.app/\n")
})

test("El workflow acepta el JSON envuelto del modo no interactivo", () => {
  const result = readOutput({ status: "ok", deployment })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, "url=https://rescate-ci.vercel.app/\n")
})

test("El workflow rechaza un deploy pendiente o fallido antes de emitir la URL", () => {
  for (const readyState of ["BUILDING", "ERROR", "CANCELED", undefined]) {
    const result = readOutput({ ...deployment, readyState })
    assert.notEqual(result.status, 0)
    assert.equal(result.output, "")
  }
  assert.notEqual(readOutput({ status: "error", deployment }).status, 0)
})

test("El workflow rechaza una URL ausente o sin HTTPS", () => {
  for (const url of [undefined, "http://rescate-ci.vercel.app", "invalida"]) {
    const result = readOutput({ ...deployment, url })
    assert.notEqual(result.status, 0)
    assert.equal(result.output, "")
  }
})
