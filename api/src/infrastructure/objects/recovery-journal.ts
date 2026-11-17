import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { RecoveryFacts, RecoveryJournal, RecoveryTicket } from '../../application/recovery/journal.js'
import { RecoveryJournalUnavailableError } from '../../application/recovery/journal.js'

const PREFIX = 'rescate-backups/v1/journal/'
const ALLOWED = new Set(['id', 'publicId', 'lotId', 'reservationId', 'entryId', 'incidentId', 'quantity', 'status',
  'version', 'createdAt', 'endedAt', 'publishedAt', 'deliveredAt', 'lotClosed', 'expiredReservations', 'closedEntries'])

export function decryptRecoveryRecord(bytes: Uint8Array, key: Uint8Array): Record<string, unknown> {
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (envelope.format !== 1 || envelope.keyId !== createHash('sha256').update(key).digest('hex').slice(0, 16)) throw new Error('Clave o formato del diario incorrecto')
  const nonce = Buffer.from(envelope.nonce, 'base64'); const tag = Buffer.from(envelope.tag, 'base64')
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Diario incompleto')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'))
}

/** Proyección mínima: nunca se guardan códigos, contraseñas, chat, motivos ni instrucciones. */
export function recoveryResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (!ALLOWED.has(key)) return []
    if (item instanceof Date) return [[key, item.toISOString()]]
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
      || typeof item === 'string' && item.length <= 128) return [[key, item]]
    return []
  }))
}

export function createRecoveryJournal(environment: NodeJS.ProcessEnv,
  actor: (id: string) => Promise<{ publicId: string; email: string } | null>,
  transport?: Pick<S3Client, 'send' | 'destroy'>): RecoveryJournal | null {
  const encoded = environment.RECOVERY_JOURNAL_KEY
  if (!encoded && environment.NODE_ENV !== 'production') return null
  const key = Buffer.from(encoded ?? '', 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('RECOVERY_JOURNAL_KEY requiere 32 bytes aleatorios en base64 canónico')
  const scope = environment.RECOVERY_JOURNAL_SCOPE ?? environment.RAILWAY_ENVIRONMENT_ID ?? ''
  if (!/^[a-z0-9-]{1,64}$/i.test(scope)) throw new Error('Falta RECOVERY_JOURNAL_SCOPE del entorno')
  const required = (suffix: string): string => {
    const value = environment[`RECOVERY_S3_${suffix}`] ?? environment[`PHOTO_S3_${suffix}`]
    if (!value) throw new Error(`Falta almacenamiento del diario: ${suffix}`)
    return value
  }
  const endpoint = new URL(required('ENDPOINT'))
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('El diario requiere un bucket privado HTTPS')
  const Bucket = required('BUCKET')
  const client = transport ?? new S3Client({ endpoint: endpoint.href, region: required('REGION'), forcePathStyle: true,
    credentials: { accessKeyId: required('ACCESS_KEY_ID'), secretAccessKey: required('SECRET_ACCESS_KEY') },
    maxAttempts: 2, requestHandler: { connectionTimeout: 1500, requestTimeout: 2500 } })
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  async function write(ticket: RecoveryTicket, phase: string, value: object): Promise<void> {
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const bytes = Buffer.concat([cipher.update(JSON.stringify({ format: 1, id: ticket.id, preparedAt: ticket.preparedAt,
        recordedAt: new Date().toISOString(), ...value })), cipher.final()])
      const body = Buffer.from(JSON.stringify({ format: 1, keyId, nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') }))
      await client.send(new PutObjectCommand({ Bucket, Key: `${PREFIX}${scope}/${ticket.preparedAt.slice(0, 10)}/${ticket.id}/${phase}.json`,
        Body: body, ContentType: 'application/octet-stream', ContentLength: body.length }))
    } catch { throw new RecoveryJournalUnavailableError() }
  }
  return {
    async prepare(facts: RecoveryFacts): Promise<RecoveryTicket> {
      try {
        const who = facts.actorId ? await actor(facts.actorId) : null
        const ticket = { id: randomUUID(), preparedAt: new Date().toISOString() }
        // El contacto permite avisar incluso si la cuenta nació después de la copia.
        // Se cifra junto con el resto y nunca se incluye en stdout ni en la respuesta HTTP.
        await write(ticket, 'prepared', { phase: 'prepared', scope, facts,
          actor: who ? { id: who.publicId, email: who.email } : null })
        return ticket
      } catch { throw new RecoveryJournalUnavailableError() }
    },
    async complete(ticket, result) { await write(ticket, 'outcome', { phase: 'confirmed', result: recoveryResult(result) }) },
    async reject(ticket, definite) { await write(ticket, 'outcome', { phase: definite ? 'rejected' : 'uncertain' }) },
    close() { client.destroy() },
  }
}
