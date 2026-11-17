// Segunda copia cifrada en el equipo de Operación/revisor; no descarga ni imprime la clave.
import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { backupKey, backupStore, decryptBackup, listCompleteBackups } from './support/encrypted-backups.mjs'
import { sha256File } from './support/backup.mjs'

const { values } = parseArgs({ options: { salida: { type: 'string' }, todas: { type: 'boolean', default: false }, descifrar: { type: 'string' } } })
let store
try {
  assert.ok(values.salida, 'Se requiere --salida <directorio privado fuera del repositorio>')
  assert.ok(!(values.todas && values.descifrar), '--descifrar admite solo la última copia')
  const directory = resolve(values.salida)
  await mkdir(directory, { mode: 0o700 }) // Exclusivo: no sobrescribe una copia existente.
  store = backupStore()
  const entries = await listCompleteBackups(store)
  const selected = values.todas ? entries : entries.slice(0, 1)
  assert.ok(selected.length > 0, 'No hay copias completas')
  for (const entry of selected) {
    const path = join(directory, basename(entry.key))
    try {
      const source = await store.get(entry.key); assert.ok(source)
      await pipeline(source, createWriteStream(path, { mode: 0o600, flags: 'wx' }))
      const digest = await sha256File(path)
      assert.equal(digest.sha256, entry.sha256); assert.equal(digest.bytes, entry.bytes)
      await writeFile(path.replace(/\.tar\.enc$/, '.json'), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      if (values.descifrar) await decryptBackup(path, resolve(values.descifrar), backupKey())
    } catch (error) { await rm(path, { force: true }); throw error }
  }
  console.log(JSON.stringify({ event: 'backup_downloaded', copies: selected.length, latestCreatedAt: selected[0].createdAt }))
} catch {
  console.error('No se pudo descargar y verificar la copia; revisar acceso, destino vacío y clave de descifrado.')
  process.exitCode = 1
} finally { store?.close() }
