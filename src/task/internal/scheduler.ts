import { Deferred, Effect, Exit, Fiber, Scope, Stream } from 'effect'
import { Session } from '../../session/Session.ts'
import type { CommitPublication, Tx } from '../../session/Session.ts'
import { Storage } from '../../storage/Storage.ts'
import type { TaskId } from '../../storage/schema/Ids.ts'
import type { TaskRecord } from '../../storage/schema/Task.ts'
import { Registry } from '../Registry.ts'
import type { Service } from '../Scheduler.ts'
import { terminate } from './invocation.ts'
import { resolve } from './resolve.ts'
import { drive } from './reserve.ts'
import {
  kick,
  makeState,
  readsFirst,
  resolveReceipt,
  seal,
  track,
  withAbortMark,
  withState,
} from './state.ts'
import type { State } from './state.ts'
import { notFound, waitForTask } from './wait.ts'

const LIVE_STATUSES = ['pending', 'running', 'waiting', 'completing'] as const
const SCAN_PAGE_SIZE = 256

/**
 * The commit listener, on the line: mirror every task change, complete receipts, and interrupt
 * the run invocation of a newly abort-marked task. Its next step ends it, and the abort handler
 * runs in a fresh invocation.
 */
const observe = (state: State) => (publication: CommitPublication) =>
  Effect.gen(function* () {
    let changed = false
    for (const change of publication.changes) {
      if (change.type !== 'task') continue
      changed = true
      const record = change.value
      const previous = state.live.get(record.id)
      track(state, previous, record)
      yield* resolveReceipt(state, record)
      if (!record.abortRequested || previous?.abortRequested === true) continue
      const invocation = state.invocations.get(record.id)
      // Not forked yet: its first step finds the mark.
      if (invocation?.mode === 'run' && invocation.fiber !== undefined) {
        yield* Effect.forkDetach(Fiber.interrupt(invocation.fiber))
      }
    }
    if (changed) kick(state)
  })

/** Every task record in one status, read in pages. */
const scanStatus = Effect.fnUntraced(function* (tx: Tx, status: (typeof LIVE_STATUSES)[number]) {
  const records: Array<TaskRecord> = []
  let page = yield* tx.scanTasks({ status }, SCAN_PAGE_SIZE)
  records.push(...page.items)
  while (page.next !== undefined) {
    page = yield* tx.scanTasks({ status }, SCAN_PAGE_SIZE, page.next)
    records.push(...page.items)
  }
  return records
})

/** Load live tasks, and change the `running` tasks a crash or close left back to `pending`. */
const recover = (state: State) =>
  readsFirst(
    state.session.commit((tx) =>
      Effect.gen(function* () {
        // Every table read before the first write.
        const records: Array<TaskRecord> = []
        for (const status of LIVE_STATUSES) records.push(...(yield* scanStatus(tx, status)))
        for (const record of records) {
          track(state, undefined, record)
          if (record.state.status === 'running') {
            const checkpoint = record.state.checkpoint
            yield* tx.setTask(withState(record, { status: 'pending', checkpoint }))
          }
        }
      }),
    ),
  )

/**
 * Commit the abort mark, or settle a task no definition can take as `orphaned` when no
 * invocation runs it; then wait for the run invocation the observer interrupted.
 */
const abort = (state: State) => (id: TaskId) =>
  Effect.gen(function* () {
    const marked = yield* readsFirst(
      state.session.commit((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.task(id)
          if (current === undefined) return yield* notFound(id)
          if (current.state.status === 'terminal') return { result: 'terminal' as const }
          const invocation = state.invocations.get(id)
          if (invocation === undefined && current.state.status !== 'completing') {
            const resolution = yield* resolve(state, current, yield* state.registry.snapshot)
            if (resolution.kind === 'blocked') {
              yield* terminate(tx, current, { status: 'orphaned', reason: resolution.reason })
              return { result: 'marked' as const }
            }
          }
          if (!current.abortRequested || current.abortReason !== undefined) {
            yield* tx.setTask(withAbortMark(current))
          }
          return {
            result: 'marked' as const,
            run: invocation?.mode === 'run' ? invocation : undefined,
          }
        }),
      ),
    )
    if ('run' in marked && marked.run !== undefined) yield* Deferred.await(marked.run.done)
    return marked.result
  })

/** Seal, then interrupt every invocation and wait for it: close writes no outcome. */
const close = (state: State) => Effect.andThen(seal(state), Scope.close(state.scope, Exit.void))

export const make = Effect.gen(function* () {
  const session = yield* Session
  const storage = yield* Storage
  const registry = yield* Registry
  // Invocations and the driver run in a child scope, so close can seal before interrupting them.
  const scope = yield* Scope.fork(yield* Effect.scope)
  const state = makeState(session, storage, registry, scope)
  yield* Effect.addFinalizer(() => close(state))
  yield* session.observeCommits(observe(state))
  yield* recover(state)
  yield* Effect.forkIn(drive(state), scope)
  yield* Effect.forkIn(
    Stream.runForEach(registry.changes, () =>
      Effect.sync(() => {
        kick(state)
      }),
    ),
    scope,
  )
  kick(state)
  const service: Service = {
    abort: abort(state),
    waitForTask: (id) => waitForTask(state, id),
  }
  return service
})
