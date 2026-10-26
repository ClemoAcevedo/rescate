import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ChatRuleError, conversationClosesAt, isConversationOpen, isHistoryRetained, requireMessageText,
} from '../src/domain/chat.js'
import { createChatUseCases } from '../src/application/chat/use-cases.js'
import type { ChatRepository, ChatReservation, SendState } from '../src/application/chat/ports.js'

const at = new Date('2030-01-15T12:00:00Z')
const hours = (n: number) => new Date(at.getTime() + n * 3_600_000)
const open: ChatReservation = { participation: 'holder', endedAt: null, pickupEndsAt: hours(2), lotClosedAt: null }
const actor = { userId: '1' }
const key = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('el texto se recorta y tiene entre 1 y 1000 caracteres contados por código', () => {
  assert.equal(requireMessageText('  hola  '), 'hola')
  assert.equal(requireMessageText('🍞'.repeat(1000)).length, 2000)
  for (const text of ['', '   \n', 'a'.repeat(1001)]) assert.throws(() => requireMessageText(text), ChatRuleError)
})

test('la conversación cierra con lo primero entre fin de la reserva, de la ventana o del lote', () => {
  assert.deepEqual(conversationClosesAt(open), hours(2))
  assert.deepEqual(conversationClosesAt({ ...open, endedAt: hours(-1) }), hours(-1))
  assert.deepEqual(conversationClosesAt({ ...open, lotClosedAt: hours(1) }), hours(1))
  assert.equal(isConversationOpen(open, at), true)
  assert.equal(isConversationOpen(open, hours(2)), false, 'el cierre de la ventana es exclusivo')
})

test('el historial se muestra hasta treinta días después del cierre', () => {
  const cancelled = { ...open, endedAt: at }
  assert.equal(isHistoryRetained(cancelled, new Date(at.getTime() + 30 * 86_400_000 - 1)), true)
  assert.equal(isHistoryRetained(cancelled, new Date(at.getTime() + 30 * 86_400_000)), false)
})

function repository(reservation: ChatReservation | null, state: SendState = reservation
  ? { existing: null, reservation, now: at } : { existing: null, reservation: null }) {
  const appended: string[] = []
  const notified: string[] = []
  const repo: ChatRepository = {
    findReservation: async () => reservation,
    listMessages: async (_user, _id, after, limit) => Array.from({ length: limit }, (_, index) => ({
      id: `m${after + index + 1}`, sequence: after + index + 1, author: 'holder' as const, mine: true, text: 'hola', createdAt: at })),
    withSendTransaction: async (_user, _id, _key, _text, operate) => operate(state, {
      append: async (text, createdAt, notify) => {
        appended.push(text); notified.push(notify)
        return { id: 'm1', sequence: 1, createdAt }
      },
    }),
    eraseExpired: async () => 0,
  }
  return { repo, appended, notified }
}

test('participantes envían en una conversación abierta con el instante de la base', async () => {
  const { repo, appended } = repository(open)
  const processClock = () => assert.fail('enviar no debe leer el reloj del proceso')
  const sent = await createChatUseCases(repo, processClock).send(actor, 'R', '  ¿A qué hora paso?  ', key.toUpperCase())
  assert.deepEqual(sent, { id: 'm1', sequence: 1, createdAt: at })
  assert.deepEqual(appended, ['¿A qué hora paso?'])
})

test('cada mensaje avisa a la otra parte y nunca a quien lo escribió', async () => {
  const fromHolder = repository(open)
  await createChatUseCases(fromHolder.repo, () => at).send(actor, 'r', 'hola', key)
  const fromOperator = repository({ ...open, participation: 'operator' })
  await createChatUseCases(fromOperator.repo, () => at).send(actor, 'r', 'hola', key)
  assert.deepEqual([fromHolder.notified, fromOperator.notified], [['operators'], ['holder']])
})

test('cancelar, vencer o cerrar el lote impide enviar', async () => {
  for (const closed of [{ ...open, endedAt: hours(-1) }, { ...open, pickupEndsAt: at }, { ...open, lotClosedAt: at }]) {
    const { repo, appended } = repository(closed)
    await assert.rejects(createChatUseCases(repo, () => at).send(actor, 'r', 'hola', key), { reason: 'closed' })
    assert.deepEqual(appended, [])
  }
})

test('alguien ajeno recibe lo mismo que una reserva inexistente', async () => {
  for (const reservation of [null, { ...open, participation: null }]) {
    const { repo } = repository(reservation)
    const cases = createChatUseCases(repo, () => at)
    await assert.rejects(cases.list(actor, 'r', 0), { code: 'reservation_not_found' })
    await assert.rejects(cases.send(actor, 'r', 'hola', key), { code: 'reservation_not_found' })
  }
})

test('un reintento devuelve el original aunque ya cerró, y otra intención con la clave es conflicto', async () => {
  const existing = { id: 'm7', sequence: 7, createdAt: at, reservationId: 'r', textMatches: true }
  const send = (state: SendState, reservationId = 'R') =>
    createChatUseCases(repository(null, state).repo, () => at).send(actor, reservationId, 'hola', key)
  assert.deepEqual(await send({ existing }), { id: 'm7', sequence: 7, createdAt: at })
  await assert.rejects(send({ existing: { ...existing, textMatches: false } }), { code: 'idempotency_conflict' })
  await assert.rejects(send({ existing }, 'otra'), { code: 'idempotency_conflict' })
})

test('el historial pagina de a 50, informa si sigue abierto y se oculta al vencer la retención', async () => {
  const page = await createChatUseCases(repository(open).repo, () => at).list(actor, 'r', 3)
  assert.equal(page.items.length, 50)
  assert.equal(page.items[0]!.sequence, 4)
  assert.equal(page.hasMore, true)
  assert.equal(page.open, true)
  const old = { ...open, endedAt: hours(-24 * 31) }
  assert.deepEqual(await createChatUseCases(repository(old).repo, () => at).list(actor, 'r', 0),
    { items: [], hasMore: false, open: false })
})
