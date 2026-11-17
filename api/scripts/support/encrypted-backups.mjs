import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { S3Client, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { sha256File } from './backup.mjs'

const execute = promisify(execFile)
const MAGIC = Buffer.from('RESCATE-BACKUP-1\n')
const IV_BYTES = 12
const TAG_BYTES = 16
export const BACKUP_PREFIX = 'rescate-backups/v1/'

export function backupKey(encoded = process.env.BACKUP_ENCRYPTION_KEY) {
  const key = Buffer.from(encoded ?? '', 'base64')
  assert.ok(key.length === 32 && key.toString('base64') === encoded, 'BACKUP_ENCRYPTION_KEY requiere 32 bytes aleatorios en base64 canónico')
  return key
}

export async function encryptBackup(directory, target, key) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  const output = createWriteStream(target, { mode: 0o600, flags: 'wx' })
  output.write(Buffer.concat([MAGIC, iv]))
  const tar = spawn('tar', ['-C', resolve(directory), '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const completed = once(tar, 'close')
  tar.stderr.resume()
  try {
    await pipeline(tar.stdout, cipher, output)
    const [code] = await completed
    assert.equal(code, 0, 'No se pudo empaquetar la copia')
    await appendFile(target, cipher.getAuthTag())
    return await sha256File(target)
  } catch (error) {
    tar.kill('SIGTERM')
    await rm(target, { force: true })
    throw error
  }
}

/** Autentica el archivo completo antes de extraerlo en un directorio vacío. */
export async function decryptBackup(archive, directory, key) {
  const size = (await stat(archive)).size
  assert.ok(size > MAGIC.length + IV_BYTES + TAG_BYTES, 'Copia cifrada incompleta')
  const header = Buffer.alloc(MAGIC.length + IV_BYTES)
  const tag = Buffer.alloc(TAG_BYTES)
  const { open } = await import('node:fs/promises')
  const file = await open(archive, 'r')
  try { await file.read(header, 0, header.length, 0); await file.read(tag, 0, tag.length, size - TAG_BYTES) } finally { await file.close() }
  assert.deepEqual(header.subarray(0, MAGIC.length), MAGIC, 'Formato de copia no admitido')
  const temporary = await mkdtemp(join(tmpdir(), 'rescate-decrypt-'))
  try {
    const plaintext = join(temporary, 'backup.tar')
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length), { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    await pipeline(createReadStream(archive, { start: header.length, end: size - TAG_BYTES - 1 }), decipher,
      createWriteStream(plaintext, { mode: 0o600, flags: 'wx' }))
    // El archivo debe contener solo archivos/directorios relativos; nunca enlaces.
    const listing = await execute('tar', ['-tf', plaintext], { maxBuffer: 16 * 2 ** 20 })
    const verbose = await execute('tar', ['-tvf', plaintext], { maxBuffer: 32 * 2 ** 20 })
    for (const name of listing.stdout.trim().split('\n')) assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), 'Ruta no permitida en la copia')
    for (const line of verbose.stdout.trim().split('\n')) assert.ok(['-', 'd'].includes(line[0]), 'La copia no admite enlaces ni dispositivos')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const { readdir } = await import('node:fs/promises')
    assert.equal((await readdir(directory)).length, 0, 'El destino debe estar vacío')
    await execute('tar', ['-xf', plaintext, '-C', resolve(directory), '--no-same-owner', '--no-same-permissions'])
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Bucket privado fuera del host de la API; los clientes reciben solo las rutas de fotos. */
export function backupStore(environment = process.env, transport) {
  const value = suffix => environment[`BACKUP_S3_${suffix}`] ?? environment[`PHOTO_S3_${suffix}`]
  const endpoint = new URL(value('ENDPOINT') ?? '')
  assert.equal(endpoint.protocol, 'https:', 'El bucket de copias requiere HTTPS')
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash)
  const Bucket = value('BUCKET')
  const region = value('REGION')
  const accessKeyId = value('ACCESS_KEY_ID')
  const secretAccessKey = value('SECRET_ACCESS_KEY')
  assert.ok(Bucket && region && accessKeyId && secretAccessKey, 'Falta configuración del bucket privado de copias')
  const client = transport ?? new S3Client({ endpoint: endpoint.href, region, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 }, maxAttempts: 3 })
  return {
    async put(key, bytes, contentType = 'application/octet-stream', size) {
      assert.ok(key.startsWith(BACKUP_PREFIX), 'Clave de copia fuera del prefijo permitido')
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType, ...(size === undefined ? {} : { ContentLength: size }) }))
    },
    async get(key) {
      try { return (await client.send(new GetObjectCommand({ Bucket, Key: key }))).Body }
      catch (error) { if (error.$metadata?.httpStatusCode === 404) return null; throw error }
    },
    async list(prefix = BACKUP_PREFIX) {
      assert.ok(prefix.startsWith(BACKUP_PREFIX), 'Prefijo no permitido')
      const keys = []
      let token
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }))
        keys.push(...(page.Contents ?? []).map(object => object.Key))
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return keys
    },
    async remove(key) {
      assert.ok(key.startsWith(BACKUP_PREFIX) && !key.includes('..'), 'Clave de copia no permitida')
      // B2 conserva los bytes si DELETE solo crea un marcador. Retirar todas las
      // versiones de esta clave, incluidos marcadores, sin alcanzar claves vecinas.
      const versions = []
      let KeyMarker, VersionIdMarker
      do {
        const page = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key, KeyMarker, VersionIdMarker }))
        versions.push(...[...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter(version => version.Key === key))
        if (page.IsTruncated) assert.ok(page.NextKeyMarker, 'Listado de versiones incompleto')
        KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined
        VersionIdMarker = page.NextVersionIdMarker
      } while (KeyMarker)
      // Completar el inventario antes de borrarlo conserva los marcadores de paginación.
      for (const version of versions) {
        assert.ok(version.VersionId, 'Versión sin identificador')
        await client.send(new DeleteObjectCommand({ Bucket, Key: key, VersionId: version.VersionId }))
      }
    },
    close() { client.destroy() },
  }
}

export async function readJson(store, key) {
  const body = await store.get(key)
  if (!body) return null
  const chunks = []; let size = 0
  for await (const chunk of body) {
    size += chunk.length
    assert.ok(size < 1024 * 1024, 'Metadatos de copia excesivos')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function writeJson(store, key, value) {
  const bytes = Buffer.from(JSON.stringify(value))
  await store.put(key, bytes, 'application/json', bytes.length)
}

export async function uploadBackup(store, archive, manifest, keyId) {
  assert.equal(manifest.photos.missing.length, 0, 'Una copia con fotos faltantes no se publica como completa')
  const name = `${BACKUP_PREFIX}${manifest.createdAt.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const digest = await sha256File(archive)
  await store.put(`${name}.tar.enc`, createReadStream(archive), 'application/octet-stream', digest.bytes)
  const remote = await store.get(`${name}.tar.enc`)
  assert.ok(remote, 'El bucket no devolvió la copia subida')
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of remote) { hash.update(chunk); bytes += chunk.length }
  assert.equal(hash.digest('hex'), digest.sha256, 'La copia subida no conserva su sha256')
  assert.equal(bytes, digest.bytes)
  const metadata = { format: 1, createdAt: manifest.createdAt, completedAt: new Date().toISOString(),
    key: `${name}.tar.enc`, sha256: digest.sha256, bytes, keyId,
    manifestSha256: createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex') }
  await writeJson(store, `${name}.json`, metadata)
  return metadata
}

export async function listCompleteBackups(store) {
  const keys = await store.list()
  const pattern = /^rescate-backups\/v1\/\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-f0-9]{8}\.json$/
  const entries = []
  for (const key of keys.filter(key => pattern.test(key))) {
    const metadata = await readJson(store, key)
    assert.ok(metadata && metadata.key === key.replace(/\.json$/, '.tar.enc') && keys.includes(metadata.key)
      && Number.isFinite(Date.parse(metadata.createdAt)) && /^[a-f0-9]{64}$/.test(metadata.sha256), 'Inventario de copias incompleto; se detiene la rotación')
    entries.push({ ...metadata, metadataKey: key })
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return entries
}

/** Conserva la última copia completa de cada uno de los siete días más recientes. */
export async function rotateBackups(store) {
  const entries = await listCompleteBackups(store)
  const days = new Set()
  const kept = []
  const removed = []
  for (const entry of entries) {
    const day = entry.createdAt.slice(0, 10)
    if (!days.has(day) && days.size < 7) { days.add(day); kept.push(entry); continue }
    // Quitar primero el marcador de completitud: una interrupción deja un archivo huérfano,
    // no una copia que aparenta estar completa sin su archivo.
    await store.remove(entry.metadataKey)
    await store.remove(entry.key)
    removed.push(entry.key)
  }
  return { kept, removed }
}
