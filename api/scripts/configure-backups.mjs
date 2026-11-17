// Configuración reproducible del servicio existente. No crea servicios ni cambia la base.
import assert from 'node:assert/strict'
import { environmentQuery, railway, upsertVariables } from './support/railway-load.mjs'

const projectId = process.env.RAILWAY_PROJECT_ID
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID
const serviceId = process.env.SERVICE_ID
const sha = process.env.DEPLOY_SHA
assert.ok(projectId && environmentId && serviceId && /^[a-f0-9]{40}$/.test(sha ?? ''), 'Faltan IDs o DEPLOY_SHA')
const { environment } = await railway(environmentQuery, { id: environmentId })
assert.equal(environment.projectId, projectId)
const service = environment.serviceInstances.edges.find(({ node }) => node.serviceId === serviceId)?.node
assert.equal(service?.serviceName, 'backups', 'El destino debe ser el servicio backups, nunca API, worker ni PostgreSQL')
await railway(`mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)
}`, { serviceId, environmentId, input: { dockerfilePath: 'Dockerfile.backup',
  startCommand: 'node scripts/backup-scheduled.mjs', restartPolicyType: 'NEVER', numReplicas: 1, cronSchedule: '0 */12 * * *' } })
await railway(upsertVariables, { input: { projectId, environmentId, serviceId, skipDeploys: true,
  variables: { BACKUP_TOOL_SHA: sha, BACKUP_TOOL_DIRTY: '0' } } })
console.log('PASS configuración backups: cron UTC, imagen nativa y procedencia del release')
