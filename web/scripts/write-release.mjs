import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

const commit = process.env.DEPLOY_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Falta el SHA completo del commit de despliegue')
writeFileSync('dist/release.json', JSON.stringify({ commit }) + '\n')
