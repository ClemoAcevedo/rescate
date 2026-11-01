import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Las variables pueden contener credenciales: viajan en un archivo privado, nunca en argv.
export async function railway(query, variables = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rescate-railway-'))
  try {
    const path = join(dir, 'variables.json')
    await writeFile(path, JSON.stringify(variables), { mode: 0o600 })
    const { stdout } = await execute('railway', ['api', query, '--variables', `@${path}`, '--compact'],
      { timeout: 120000, maxBuffer: 32 * 2 ** 20 })
    const result = JSON.parse(stdout)
    if (result.errors?.length || !result.data) throw new Error('GraphQL')
    return result.data
  } catch {
    throw new Error('Railway no confirmó la operación; revisa acceso, configuración y logs en su panel.')
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function assertLoadEnvironment(environment, production, ids) {
  assert.equal(production.name, 'production', 'La referencia de producción debe ser el entorno production')
  assert.ok(/^carga-e3(?:-[a-z0-9]+)*$/.test(environment.name), 'Se requiere un entorno carga-e3 dedicado')
  assert.notEqual(environment.id, production.id, 'El entorno de carga debe ser distinto de producción')
  assert.equal(environment.projectId, production.projectId, 'Los entornos deben pertenecer al mismo proyecto')
  assert.equal(new Set(Object.values(ids)).size, 3, 'API, worker y PostgreSQL deben ser servicios distintos')
  const services = environment.serviceInstances.edges.map(({ node }) => node.serviceId)
  assert.ok(Object.values(ids).every(id => services.includes(id)), 'Faltan servicios en el entorno de carga')
  const mine = environment.volumeInstances.edges.map(({ node }) => node).filter(v => v.serviceId === ids.db)
  const other = new Set(production.volumeInstances.edges.map(({ node }) => node.externalId))
  assert.equal(mine.length, 1, 'PostgreSQL requiere su propio volumen')
  assert.ok(mine[0].externalId && !other.has(mine[0].externalId), 'El volumen de carga debe ser distinto de producción')
}

export function assertLoadUrl(apiUrl, productionDomains, domains) {
  const url = new URL(apiUrl)
  assert.equal(url.protocol, 'https:', 'La API Railway requiere HTTPS')
  assert.ok(!url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/', 'API_URL debe ser un origen HTTPS estándar sin credenciales')
  assert.ok(domains.includes(url.hostname), 'El dominio debe pertenecer a la API del entorno de carga')
  assert.ok(!productionDomains.includes(url.hostname), 'El dominio de producción no admite carga')
  return url.origin
}

export function trialDatabaseUrls(publicUrl, privateUrl, name) {
  assert.match(name, /^rescate_k032_railway_[a-z0-9_]+$/, 'Nombre de base de carga inválido')
  return [publicUrl, privateUrl].map(value => {
    const url = new URL(value)
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Se requiere PostgreSQL')
    url.pathname = `/${name}`
    return url.href
  })
}

export function assertDatabaseProxy(publicUrl, proxies) {
  const url = new URL(publicUrl)
  const hostname = value => value.toLowerCase().replace(/\.$/, '')
  assert.ok(proxies.some(proxy => hostname(proxy.domain) === hostname(url.hostname) && String(proxy.proxyPort) === url.port),
    'La URL PostgreSQL debe usar el proxy TCP del servicio de carga')
}

export const environmentQuery = `query($id:String!) { environment(id:$id) { id name projectId
  serviceInstances { edges { node { id serviceId serviceName region startCommand
    domains { serviceDomains { domain } customDomains { domain } }
    latestDeployment { id status } } } }
  volumeInstances { edges { node { id serviceId externalId mountPath sizeMB } } }
} }`

export const variablesQuery = `query($projectId:String!,$environmentId:String!,$serviceId:String!) {
  variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
}`
export const upsertVariables = `mutation($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`
