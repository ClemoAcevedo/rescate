import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acceptDecimal } from '../../web/src/lots/lot-form.ts'

test('El filtro decimal conserva la escritura parcial y rechaza signos o separadores extra', () => {
  for (const [input, expected] of [['', ''], ['-', '-'], ['.', '.'], ['-.', '-.'], ['12.', '12.'],
    ['.5', '.5'], ['-12,50', '-12.50'], [' 0 ', '0'], ['1.2.3', null], ['1,2,3', null],
    ['--1', null], ['1-2', null], ['+1', null], ['1e2', null], ['1 2', null], ['١', null]] as const) {
    assert.equal(acceptDecimal(input), expected, input)
  }
})

test('Una coordenada larga inválida se rechaza sin bloquear el proceso', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { acceptDecimal } from '../web/src/lots/lot-form.ts'
    assert.equal(acceptDecimal('1'.repeat(200000) + 'x'), null)
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 5000, encoding: 'utf8' })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
})
