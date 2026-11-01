import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { getMigrationFilePaths } from 'node-pg-migrate/migration'

test('La dependencia corregida descubre migraciones SQL, respeta exclusiones y orden numérico', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rescate-migration-glob-'))
  try {
    for (const name of ['10_tenth.sql', '2_second.sql', '1_first.sql', '3_skip.sql', '.hidden.sql', '4_other.txt']) {
      writeFileSync(join(directory, name), '-- fixture\n')
    }
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'nested', '5_nested.sql'), '-- fixture\n')
    const files = await getMigrationFilePaths(join(directory, '*.sql'), {
      useGlob: true, ignorePattern: join(directory, '3_skip.sql'),
    })
    assert.deepEqual(files.map(file => basename(file)), ['1_first.sql', '2_second.sql', '10_tenth.sql'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
