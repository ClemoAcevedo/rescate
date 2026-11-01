import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

test('ESLint sigue incluyendo TypeScript y TSX y excluyendo dependencias y build', async () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) })
  for (const file of ['src/lots/lot-form.ts', 'src/pages/LoginPage.tsx']) {
    assert.equal(await eslint.isPathIgnored(file), false, file)
    const config = await eslint.calculateConfigForFile(file)
    assert.ok(config.rules['@typescript-eslint/no-unused-vars'][0] > 0, file)
  }
  for (const file of ['dist/fixture.tsx', 'node_modules/fixture.ts']) {
    assert.equal(await eslint.isPathIgnored(file), true, file)
  }
})
