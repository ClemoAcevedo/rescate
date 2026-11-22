import assert from "node:assert/strict"
import test from "node:test"
import {
  DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, NoSuchKey, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3"
import { createS3ObjectStore } from "../src/infrastructure/objects/s3-object-store.js"
import { withTransaction, type Pool, type PoolClient } from "../src/infrastructure/postgres/pool.js"

const store = () => createS3ObjectStore({
  endpoint: "https://s3.example.invalid",
  bucket: "fotos-de-prueba",
  region: "us-west-004",
  accessKeyId: "fake-key",
  secretAccessKey: "fake-secret",
})

test("el almacenamiento de fotos conserva tipo, privacidad e inexistencia y propaga otros errores", async (t) => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  let getResult = "found"
  const unavailable = new Error("Servicio no disponible")
  t.mock.method(S3Client.prototype, "send", async (command: PutObjectCommand | GetObjectCommand, options: { abortSignal: AbortSignal }) => {
    assert.ok(options.abortSignal instanceof AbortSignal)
    assert.equal(command.input.Bucket, "fotos-de-prueba")
    assert.equal(command.input.Key, "lot-photos/lote/foto.png")
    if (command instanceof PutObjectCommand) {
      assert.deepEqual(command.input.Body, bytes)
      assert.equal(command.input.ContentType, "image/png")
      assert.equal(command.input.CacheControl, "no-store")
      return {}
    }
    assert.ok(command instanceof GetObjectCommand)
    if (getResult === "missing") throw new NoSuchKey({ $metadata: {} })
    if (getResult === "empty") return {}
    if (getResult === "unavailable") throw unavailable
    return { Body: { transformToByteArray: async () => bytes } }
  })
  const photos = store()
  await photos.put("lote/foto.png", bytes, "image/png")
  assert.deepEqual(await photos.get("lote/foto.png"), bytes)
  getResult = "missing"
  assert.equal(await photos.get("lote/foto.png"), null)
  getResult = "empty"
  assert.equal(await photos.get("lote/foto.png"), null)
  getResult = "unavailable"
  await assert.rejects(photos.get("lote/foto.png"), error => error === unavailable)
})

test("quitar una foto versionada borra sus versiones y marcas, sin afectar claves vecinas", async (t) => {
  const key = "lot-photos/lote/foto.png"
  const deletes: DeleteObjectCommand["input"][] = []
  let versioned = true
  t.mock.method(S3Client.prototype, "send", async (command: ListObjectVersionsCommand | DeleteObjectCommand) => {
    assert.equal(command.input.Bucket, "fotos-de-prueba")
    if (command instanceof ListObjectVersionsCommand) {
      assert.equal(command.input.Prefix, key)
      return versioned ? {
        Versions: [{ Key: key, VersionId: "v1" }, { Key: key, VersionId: "v2" }, { Key: key + ".otra", VersionId: "neighbor" }],
        DeleteMarkers: [{ Key: key, VersionId: "marker" }],
      } : {}
    }
    assert.ok(command instanceof DeleteObjectCommand)
    deletes.push(command.input)
    return {}
  })
  const photos = store()
  await photos.remove("lote/foto.png")
  assert.deepEqual(deletes.map(({ Key, VersionId }) => [Key, VersionId]), [[key, "v1"], [key, "v2"], [key, "marker"]])
  versioned = false
  await photos.remove("lote/foto.png")
  assert.deepEqual(deletes.at(-1), { Bucket: "fotos-de-prueba", Key: key })
})

test("una confirmación y reversión fallidas preservan el error original y liberan el cliente", async () => {
  const operations: string[] = []
  const commitError = new Error("Confirmación no disponible")
  const client = {
    async query(query: string) {
      operations.push(query)
      if (query === "COMMIT") throw commitError
      if (query === "ROLLBACK") throw new Error("Conexión cerrada")
    },
    release() { operations.push("release") },
  } as unknown as PoolClient
  const pool = { async connect() { return client } } as unknown as Pool
  await assert.rejects(withTransaction(pool, async connection => {
    assert.equal(connection, client)
    operations.push("write")
    return "no se debe devolver"
  }), error => error === commitError)
  assert.deepEqual(operations, ["BEGIN", "write", "COMMIT", "ROLLBACK", "release"])
})
