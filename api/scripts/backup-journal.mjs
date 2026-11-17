// Informe privado de operaciones posteriores a la copia. Nunca reejecuta una entrega.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { backupKey, backupStore } from './support/encrypted-backups.mjs'
import { readManifest, remoteDatabase } from './support/backup.mjs'
import { applyDecisions, readRecoveryJournal, reconciliationReport } from './support/recovery-journal.mjs'

const { positionals: [directory], values } = parseArgs({ allowPositionals: true, options: {
  salida: { type: 'string' }, decisiones: { type: 'string' }, 'manifiesto-sha256': { type: 'string' },
} })
let store; let client
try {
  assert.ok(directory && values.salida, 'Indicar copia y --salida <informe privado>')
  const manifest = await readManifest(resolve(directory), values['manifiesto-sha256'] ?? null)
  const key = backupKey(process.env.RECOVERY_JOURNAL_KEY)
  store = backupStore({ ...process.env, ...Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.startsWith('RECOVERY_S3_')).map(([name, value]) => [name.replace('RECOVERY_', 'BACKUP_'), value])) })
  const records = await readRecoveryJournal(store, process.env.RECOVERY_JOURNAL_SCOPE, key)
  const target = await remoteDatabase(process.env.K053_TARGET_DATABASE_URL, 'K053_TARGET_DATABASE_URL')
  client = target.client({ options: '-c default_transaction_read_only=on' })
  await client.connect()
  let report = await reconciliationReport(client, records, manifest.createdAt)
  if (values.decisiones) report = applyDecisions(report, JSON.parse(await readFile(values.decisiones, 'utf8')))
  await writeFile(resolve(values.salida), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ event: 'recovery_reconciliation', cases: report.items.length, readyToReopen: report.readyToReopen }))
  process.exitCode = report.readyToReopen ? 0 : 2
} catch {
  console.error('No se pudo completar la conciliación del diario; mantener cerrado y revisar acceso, integridad y decisiones.')
  process.exitCode = 1
} finally { await client?.end().catch(() => {}); store?.close() }
