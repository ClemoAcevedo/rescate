import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { compile } from 'json-schema-to-typescript'

const document = parse(await readFile(new URL('../../docs/api/openapi.yaml', import.meta.url), 'utf8'))
// DTO consumidos por K008/K010; las definiciones y referencias provienen del YAML.
const names = ['LoginRequest', 'LoginResponse', 'RegisterRequest', 'RegisterResponse', 'SessionResponse', 'CreateLotDraftRequest', 'UpdateLotDraftRequest', 'PublishLotDraftRequest', 'LotResponse', 'ErrorResponse', 'ValidationIssue']
const definitions = JSON.parse(JSON.stringify(document.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'))
const output = await compile({
  type: 'object', additionalProperties: false, required: names,
  properties: Object.fromEntries(names.map(name => [name, { $ref: `#/definitions/${name}` }])),
  definitions,
}, 'HttpSchemas', {
  bannerComment: '/* Generado desde docs/api/openapi.yaml. No editar; npm run api:types. */',
  style: { semi: false, singleQuote: false },
})
// La web compila por separado (su propio build y Dockerfile), por eso recibe una copia idéntica.
const targets = [
  new URL('../src/http/openapi.ts', import.meta.url),
  new URL('../../web/src/services/openapi.ts', import.meta.url),
]
for (const target of targets) {
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (current !== output) throw new Error(`Tipos HTTP desactualizados en ${target.pathname}: ejecuta npm run api:types`)
  } else await writeFile(target, output)
}
