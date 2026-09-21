// Valida respuestas HTTP reales con JSON Schema 2020-12 del contrato, sin copiar schemas.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { Ajv2020 } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const contract = parse(readFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url), "utf8"))
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addSchema({ $id: "rescate", components: contract.components })
const validators = new Map<string, ReturnType<typeof ajv.compile>>()
export function assertContract(method: string, path: string, response: Response, body: unknown): void {
  const route = path.startsWith("/auth/") ? path : path.startsWith("/establishments/") ? "/establishments/{establishmentId}/lots"
    : path.endsWith("/publish") ? "/lots/{lotId}/publish" : "/lots/{lotId}"
  const operation = contract.paths[route][method.toLowerCase()]
  let spec = operation.responses[String(response.status)]
  assert.ok(spec, `${method} ${route}: status ${response.status} no contratado`)
  if (spec.$ref) spec = contract.components.responses[spec.$ref.split("/").at(-1)]
  assert.equal(response.headers.get("cache-control"), "no-store")
  if (response.status === 204) { assert.equal(body, undefined); return }
  const ref = spec.content["application/json"].schema.$ref
  let validate = validators.get(ref)
  if (!validate) { validate = ajv.compile({ $ref: `rescate${ref}` }); validators.set(ref, validate) }
  assert.ok(validate(body), JSON.stringify(validate.errors))
  assert.equal(response.headers.get("cache-control"), "no-store")
}
