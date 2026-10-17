import { Effect } from 'effect'
import type { TransactionScope, Tx } from '../Session.ts'
import { assemble } from './transaction/assemble.ts'
import { stageConversation, stageFork, stageRootConversation } from './transaction/conversations.ts'
import * as Records from './transaction/records.ts'
import { committedTask, makeState, read, rejected, write } from './transaction/state.ts'
import type { Host, TxState } from './transaction/state.ts'

/**
 * Transaction of one commit callback, ported from pi's `session/transaction.ts` without its
 * document tracking.
 *
 * Conversation and entry writes stage eagerly; tasks and submissions are kept per ID as their
 * latest candidate. When the callback ends the transaction seals, and every later operation
 * fails; on success the staged writes are validated and assembled into one batch.
 */
export interface Transaction {
  readonly tx: Tx
  readonly state: TxState
}

const makeTx = (state: TxState): Tx => {
  const { guard, storage } = state.host
  return {
    conversation: (id) => read(state, 'conversation', guard(storage.conversation(id))),
    entry: (id) =>
      read(
        state,
        'entry',
        Effect.map(guard(storage.entry(id)), (stored) => stored?.entry),
      ),
    task: (id) => read(state, 'task', committedTask(state, id)),
    submission: (id) => read(state, 'submission', guard(storage.submission(id))),
    submissionByRequest: (conversationId, requestId) =>
      read(
        state,
        'submissionByRequest',
        guard(storage.submissionByRequest(conversationId, requestId)),
      ),
    scanConversations: (query, limit, cursor) =>
      read(state, 'scanConversations', guard(storage.scanConversations(query, limit, cursor))),
    scanEntries: (query, limit, cursor) =>
      read(state, 'scanEntries', guard(storage.scanEntries(query, limit, cursor))),
    scanTasks: (query, limit, cursor) =>
      read(state, 'scanTasks', guard(storage.scanTasks(query, limit, cursor))),
    latestHeadMarker: (conversationId) =>
      read(state, 'latestHeadMarker', guard(storage.findLatestHeadMarker(conversationId))),
    createConversation: ({ ownership }) => write(state, stageConversation(state, ownership)),
    createRootConversation: write(state, stageRootConversation(state)),
    forkConversation: (conversationId, at, { ownership }) =>
      write(state, stageFork(state, conversationId, at, ownership)),
    appendEntry: (conversationId, draft) =>
      write(state, Records.appendEntry(state, conversationId, draft)),
    createTask: (kind, input, options) =>
      write(state, Records.createTask(state, kind, input, options)),
    createSubmission: (create) => write(state, Records.createSubmission(state, create)),
    settleSubmission: (id, settlement) => Records.settleSubmission(state, id, settlement),
    placeSubmission: (id, entry) => Records.placeSubmission(state, id, entry),
    setTask: (record) => Records.setTask(state, record),
  }
}

export const makeTransaction = (host: Host, scope: TransactionScope = {}): Transaction => {
  const state = makeState(host, scope)
  return { tx: makeTx(state), state }
}

/** Seal the transaction; nothing it staged can change any more. */
export const seal = (transaction: Transaction) =>
  Effect.sync(() => {
    transaction.state.sealed = true
  })

/** Seal after the callback succeeded, then validate and assemble the batch. */
export const settle = (transaction: Transaction) =>
  Effect.flatMap(seal(transaction), () =>
    transaction.state.pending > 0
      ? rejected('Session commit callback ended before its pending Tx operations')
      : assemble(transaction.state),
  )
