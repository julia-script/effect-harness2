/* oxlint-disable max-lines-per-function -- ported describe blocks */
/**
 * Ported from pi's `packages/durable/test/session-definitions.test.ts`. Document states, watches,
 * and typed entry tokens are not ported.
 */
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { Effect } from 'effect'
import type { Tracker } from '../../delta/index.ts'
import type { Ids } from '../../storage/schema/index.ts'
import { Document, SessionError } from '../index.ts'
import type { Session } from '../index.ts'
import { createConversation, createTask, runSession } from './support.ts'

type State = { value: number }
const initial = () => Effect.succeed<State>({ value: 0 })

const SessionDoc = Document.make<State>({
  kind: 't.session',
  version: 1,
  scope: 'session',
  initial,
})
const LatestDoc = Document.make<State>({
  kind: 't.latest',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial,
})
const RewindableDoc = Document.make<State>({
  kind: 't.rewindable',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial,
})
const TaskDoc = Document.make<State>({ kind: 't.task', version: 1, scope: 'task', initial })
const SessionFamily = Document.makeFamily<State, number>({
  kind: 't.session-family',
  version: 1,
  family: true,
  scope: 'session',
  initial: (seed) => Effect.succeed({ value: seed }),
})
const ConversationFamily = Document.makeFamily<State, number>({
  kind: 't.conversation-family',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'initial',
  initial: (seed) => Effect.succeed({ value: seed }),
})
const TaskFamily = Document.makeFamily<State, number>({
  kind: 't.task-family',
  version: 1,
  family: true,
  scope: 'task',
  initial: (seed) => Effect.succeed({ value: seed }),
})

type Drafted = Tracker.Draft<State>
type Read = Readonly<State> | undefined

/** Every typed acquisition and retirement overload; compiled, and run by the next test. */
const acquireAll = (tx: Session.Tx, conversationId: Ids.ConversationId, taskId: Ids.TaskId) =>
  Effect.gen(function* () {
    const drafts = [
      yield* tx.doc(SessionDoc),
      yield* tx.doc(LatestDoc, conversationId),
      yield* tx.doc(RewindableDoc, conversationId),
      yield* tx.doc(TaskDoc, taskId),
      yield* tx.doc(SessionFamily, 'k', 1),
      yield* tx.doc(ConversationFamily, conversationId, 'k', 2),
      yield* tx.doc(TaskFamily, taskId, 'k', 3),
    ]
    expectTypeOf(drafts).toEqualTypeOf<Array<Drafted>>()
    for (const draft of drafts) draft.value += 10
  })

const retireAll = (tx: Session.Tx, conversationId: Ids.ConversationId, taskId: Ids.TaskId) =>
  Effect.all([
    tx.retireDoc(SessionDoc),
    tx.retireDoc(LatestDoc, conversationId),
    tx.retireDoc(TaskDoc, taskId),
    tx.retireDoc(SessionFamily, 'k'),
    tx.retireDoc(ConversationFamily, conversationId, 'k'),
    tx.retireDoc(TaskFamily, taskId, 'k'),
  ])

/** Overloads a call site must not resolve; never run. */
const rejectedOverloads = (
  session: Session.Service,
  tx: Session.Tx,
  conversationId: Ids.ConversationId,
  taskId: Ids.TaskId,
  at: Ids.EntryId,
) => [
  // @ts-expect-error Session documents take no owner
  tx.doc(SessionDoc, conversationId),
  // @ts-expect-error conversation documents require a conversation ID
  tx.doc(LatestDoc),
  // @ts-expect-error family access requires a creation seed
  tx.doc(SessionFamily, 'k'),
  // @ts-expect-error family seeds are typed
  tx.doc(SessionFamily, 'k', 'seed'),
  // @ts-expect-error family retirement takes no seed
  tx.retireDoc(TaskFamily, taskId, 'k', 1),
  // @ts-expect-error snapshots never take a creation seed
  session.snapshot(SessionFamily, 'k', 1),
  // @ts-expect-error latest conversation documents keep no history
  session.snapshotAsOf(LatestDoc, conversationId, at),
  // @ts-expect-error Session documents keep no history
  session.snapshotAsOf(SessionDoc, conversationId, at),
  // @ts-expect-error task documents keep no history
  session.snapshotAsOf(TaskDoc, taskId, at),
]

describe('document definitions', () => {
  test('validates persisted version semantics', () =>
    runSession(({ session }) =>
      Effect.gen(function* () {
        for (const version of [0, 1.5]) {
          const Invalid = Document.make<State>({ kind: 'k', version, scope: 'session', initial })
          const read = yield* Effect.flip(session.snapshot(Invalid))
          expect(read).toBeInstanceOf(SessionError.DocumentError)
          expect(read.message).toContain('positive integer')
          const acquired = yield* Effect.flip(session.commit((tx) => tx.doc(Invalid)))
          expect(acquired).toBeInstanceOf(SessionError.DocumentError)
          expect(acquired.message).toContain('positive integer')
        }
        const empty = Document.make<State>({ kind: '', version: 1, scope: 'session', initial })
        expect(empty.definition.kind).toBe('')
        expect(SessionDoc.definition.kind).toBe('t.session')
      }),
    ))

  test('types and resolves every owner, key, and seed overload', () =>
    runSession(({ session }) =>
      Effect.gen(function* () {
        const conversationId = yield* createConversation(session)
        const taskId = yield* createTask(session, conversationId)
        expect(rejectedOverloads).toBeTypeOf('function')
        yield* session.commit((tx) => acquireAll(tx, conversationId, taskId))

        const reads = [
          yield* session.snapshot(SessionDoc),
          yield* session.snapshot(LatestDoc, conversationId),
          yield* session.snapshot(RewindableDoc, conversationId),
          yield* session.snapshot(TaskDoc, taskId),
          yield* session.snapshot(SessionFamily, 'k'),
          yield* session.snapshot(ConversationFamily, conversationId, 'k'),
          yield* session.snapshot(TaskFamily, taskId, 'k'),
        ]
        expectTypeOf(reads).toEqualTypeOf<Array<Read>>()
        expect(reads).toEqual([
          { value: 10 },
          { value: 10 },
          { value: 10 },
          { value: 10 },
          { value: 11 },
          { value: 12 },
          { value: 13 },
        ])

        yield* session.commit((tx) => retireAll(tx, conversationId, taskId))
        expect(yield* session.snapshot(SessionDoc)).toBeUndefined()
        expect(yield* session.snapshot(LatestDoc, conversationId)).toBeUndefined()
        expect(yield* session.snapshot(TaskDoc, taskId)).toBeUndefined()
        expect(yield* session.snapshot(SessionFamily, 'k')).toBeUndefined()
        expect(yield* session.snapshot(ConversationFamily, conversationId, 'k')).toBeUndefined()
        expect(yield* session.snapshot(TaskFamily, taskId, 'k')).toBeUndefined()
        // Not retired above: the rewindable singleton stays.
        expect(yield* session.snapshot(RewindableDoc, conversationId)).toEqual({ value: 10 })
      }),
    ))

  test('types and resolves historical reads', () =>
    runSession(({ session }) =>
      Effect.gen(function* () {
        const conversationId = yield* createConversation(session)
        const at = yield* session.commit((tx) =>
          Effect.gen(function* () {
            ;(yield* tx.doc(RewindableDoc, conversationId)).value = 1
            ;(yield* tx.doc(ConversationFamily, conversationId, 'k', 5)).value = 6
            return (yield* tx.appendEntry(conversationId, { kind: 'mark' })).id
          }),
        )
        yield* session.commit((tx) =>
          Effect.gen(function* () {
            ;(yield* tx.doc(RewindableDoc, conversationId)).value = 2
            ;(yield* tx.doc(ConversationFamily, conversationId, 'k', 5)).value = 7
          }),
        )
        const singleton = yield* session.snapshotAsOf(RewindableDoc, conversationId, at)
        expectTypeOf(singleton).toEqualTypeOf<Read>()
        expect(singleton).toEqual({ value: 1 })
        const member = yield* session.snapshotAsOf(ConversationFamily, conversationId, 'k', at)
        expectTypeOf(member).toEqualTypeOf<Read>()
        expect(member).toEqual({ value: 6 })
      }),
    ))
})
