import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { backupKey, decryptBackup, encryptBackup, rotateBackups, uploadBackup } from '../scripts/support/encrypted-backups.mjs'

function memoryStore() {
  const values = new Map()
  const removed = []
  return {
    values, removed,
    async get(key) { return values.has(key) ? Readable.from([values.get(key)]) : null },
    async put(key, bytes) {
      if (Buffer.isBuffer(bytes)) values.set(key, bytes)
      else { const chunks = []; for await (const chunk of bytes) chunks.push(Buffer.from(chunk)); values.set(key, Buffer.concat(chunks)) }
    },
    async list() { return [...values.keys()] },
    async remove(key) { removed.push(key); values.delete(key) },
  }
}

test('copia cifrada autenticada: recupera bytes, rechaza clave errónea, corrupción y truncamiento antes de extraer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rescate-backup-test-'))
  try {
    const source = join(root, 'source'); await mkdir(source)
    const data = randomBytes(300_000)
    await writeFile(join(source, 'database.dump'), data, { mode: 0o600 })
    const key = backupKey(randomBytes(32).toString('base64'))
    const archive = join(root, 'backup.enc')
    await encryptBackup(source, archive, key)
    assert.equal((await stat(archive)).mode & 0o777, 0o600)
    const content = await readFile(archive)
    assert.equal(content.includes(data.subarray(0, 100)), false)
    const restored = join(root, 'restored')
    await decryptBackup(archive, restored, key)
    assert.deepEqual(await readFile(join(restored, 'database.dump')), data)
    await assert.rejects(decryptBackup(archive, join(root, 'wrong'), randomBytes(32)))
    const changed = Buffer.from(content); changed[100] ^= 1
    await writeFile(join(root, 'changed.enc'), changed)
    await assert.rejects(decryptBackup(join(root, 'changed.enc'), join(root, 'corrupt'), key))
    await writeFile(join(root, 'short.enc'), content.subarray(0, 40))
    await assert.rejects(decryptBackup(join(root, 'short.enc'), join(root, 'truncated'), key))
    for (const directory of ['wrong', 'corrupt', 'truncated']) await assert.rejects(stat(join(root, directory)), { code: 'ENOENT' })
    assert.throws(() => backupKey('clave-corta'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('la extracción no acepta enlaces aunque el archivo cifrado sea auténtico', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rescate-backup-link-'))
  try {
    const source = join(root, 'source'); await mkdir(source)
    await symlink('/etc/passwd', join(source, 'escape'))
    const key = randomBytes(32)
    await encryptBackup(source, join(root, 'backup.enc'), key)
    await assert.rejects(decryptBackup(join(root, 'backup.enc'), join(root, 'target'), key), /enlaces/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rotación: siete días completos, no siete ejecuciones; una copia incompleta no desplaza una válida', async () => {
  const store = memoryStore()
  const metadata = day => {
    const createdAt = `2030-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
    const base = `rescate-backups/v1/${createdAt.replace(/[:.]/g, '-')}-abcdef01`
    return { createdAt, key: `${base}.tar.enc`, sha256: 'a'.repeat(64) }
  }
  for (let day = 1; day <= 9; day++) {
    const item = metadata(day)
    store.values.set(item.key, Buffer.from('archive'))
    store.values.set(item.key.replace(/\.tar\.enc$/, '.json'), Buffer.from(JSON.stringify(item)))
  }
  store.values.set('rescate-backups/v1/2030-01-10T00-00-00-000Z-abcdef01.tar.enc', Buffer.from('incompleta'))
  const result = await rotateBackups(store)
  assert.equal(result.kept.length, 7)
  assert.deepEqual(result.kept.map(item => item.createdAt.slice(8, 10)), ['09', '08', '07', '06', '05', '04', '03'])
  assert.equal(result.removed.length, 2)
  const broken = metadata(10)
  store.values.set(broken.key.replace(/\.tar\.enc$/, '.json'), Buffer.from(JSON.stringify({ ...broken, key: 'rescate-backups/v1/missing.tar.enc' })))
  const before = store.removed.length
  await assert.rejects(rotateBackups(store), /Inventario/)
  assert.equal(store.removed.length, before, 'no rota ante un inventario inconsistente')
})

test('una subida con lectura corrupta no publica el marcador de copia completa', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rescate-backup-upload-'))
  try {
    const path = join(directory, 'archive.enc'); await writeFile(path, randomBytes(100))
    const store = memoryStore()
    store.get = async () => Readable.from([Buffer.from('corrupción')])
    const manifest = { createdAt: '2030-01-01T00:00:00.000Z', photos: { missing: [] } }
    await assert.rejects(uploadBackup(store, path, manifest, 'test'), /sha256/)
    assert.equal([...store.values.keys()].some(key => key.endsWith('.json')), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
