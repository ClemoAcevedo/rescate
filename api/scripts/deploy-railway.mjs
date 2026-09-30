import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Espera el ID devuelto por el upload, nunca el estado de otro deploy del servicio.
export async function waitForDeployment(id, list, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deployment = (await list()).find(item => item.id === id)
    if (deployment?.status === 'SUCCESS') return deployment
    if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'CANCELED'].includes(deployment?.status)) {
      throw new Error(`Railway: ${id} terminó en ${deployment.status}`)
    }
    await pause(10000)
  }
  throw new Error(`Railway: ${id} no confirmó SUCCESS dentro de 20 minutos`)
}

async function deploy() {
  const service = process.argv[2]
  const project = process.env.RAILWAY_PROJECT_ID
  const environment = process.env.RAILWAY_ENVIRONMENT_ID
  const sha = process.env.DEPLOY_SHA
  assert.ok(service && project && environment && /^[a-f0-9]{40}$/.test(sha ?? ''), 'Faltan servicio, proyecto, entorno o DEPLOY_SHA')
  const target = ['--project', project, '--environment', environment, '--service', service]
  const run = args => {
    try { return JSON.parse(execFileSync('railway', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })) }
    catch { throw new Error('Falló Railway CLI. Revisa el acceso y los logs del servicio en Railway.') }
  }
  const upload = run(['up', 'api', '--path-as-root', '--detach', '--json', '--message', `Commit ${sha}`, ...target])
  assert.match(upload.deploymentId ?? '', /^[a-f0-9-]{36}$/i, 'Railway no devolvió un ID de despliegue')
  console.log(`Railway: esperando ${upload.deploymentId}`)
  await waitForDeployment(upload.deploymentId, () => run(['deployment', 'list', '--json', '--limit', '100', ...target]))
  console.log(`PASS Railway: ${upload.deploymentId} está en SUCCESS para ${sha}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deployment_id=${upload.deploymentId}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await deploy()
}
