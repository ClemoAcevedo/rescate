import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { readPhotoStorage } from "../src/composition.js"

const web = fileURLToPath(new URL("../../web/", import.meta.url))
function load(environment: Record<string, string>) {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    "import { config } from './vercel.mjs'; console.log(JSON.stringify(config))"], {
    cwd: web,
    encoding: "utf8",
    env: { ...process.env, API_PROXY_TARGET: "", VITE_API_BASE_URL: "", VITE_AUTH_MOCK_SCENARIO: "", ...environment },
  })
}

test("Vercel conserva /api en el navegador y lo elimina antes de Railway; fallback SPA al final", () => {
  const result = load({ API_PROXY_TARGET: "https://rescate-api.up.railway.app", VITE_API_BASE_URL: "/api" })
  assert.equal(result.status, 0, result.stderr)
  const { rewrites } = JSON.parse(result.stdout)
  assert.deepEqual(rewrites, [
    { source: "/api/:path*", destination: "https://rescate-api.up.railway.app/:path*" },
    { source: "/(.*)", destination: "/index.html" },
  ])
})

test("Vercel rechaza un proxy ausente/inseguro, un cliente de otro origen y mocks", () => {
  for (const API_PROXY_TARGET of ["", "http://api.example.com", "https://api.example.com/", "https://api.example.com/path",
    "https://user:secret@api.example.com", "https://api.example.com?key=secret"]) {
    assert.notEqual(load({ API_PROXY_TARGET }).status, 0)
  }
  assert.notEqual(load({ API_PROXY_TARGET: "https://api.example.com", VITE_API_BASE_URL: "https://api.example.com" }).status, 0)
  assert.notEqual(load({ API_PROXY_TARGET: "https://api.example.com", VITE_AUTH_MOCK_SCENARIO: "success" }).status, 0)
})

test("K051: en producción API y worker guardan fotos solo en el bucket, nunca en el disco del servicio", () => {
  const s3 = { PHOTO_STORAGE: "s3", PHOTO_S3_REGION: "us-west-004", PHOTO_S3_BUCKET: "rescate-fotos-ficticio",
    PHOTO_S3_ACCESS_KEY_ID: "id-ficticio", PHOTO_S3_SECRET_ACCESS_KEY: "secreto-ficticio" }
  assert.throws(() => readPhotoStorage({ NODE_ENV: "production", PHOTO_STORAGE: "local", PHOTO_LOCAL_DIR: "/app/fotos" }),
    /no es válido en producción/)
  assert.equal(readPhotoStorage({ NODE_ENV: "production" }), null, "sin bucket la carga responde 503")
  assert.throws(() => readPhotoStorage({ NODE_ENV: "production", ...s3, PHOTO_S3_ENDPOINT: "http://s3.example.com" }), /HTTPS/)
  assert.ok(readPhotoStorage({ NODE_ENV: "production", ...s3, PHOTO_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com" }))
})
