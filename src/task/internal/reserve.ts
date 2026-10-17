import { Cause, Deferred, Effect, Option } from 'effect'
import type { Tx } from '../../session/Session.ts'
import type { TaskRecord } from '../../storage/schema/Task.ts'
import type { Snapshot } from '../Registry.ts'
import { start, terminate } from './invocation.ts'
import type { Reservation } from './invocation.ts'
import { resolve } from './resolve.ts'
import { report, seal, withState } from './state.ts'
import type { Invocation, State } from './state.ts'

/** Whether a waiting task still waits for a live task in its `on`; abort-marked ones leave. */
const waiting = (state: State, record: TaskRecord) =>
  record.state.status === 'waiting' &&
  !record.abortRequested &&
  record.state.on.some((id) => state.live.has(id))

const createInvocation = (state: State, record: TaskRecord, mode: Invocation['mode']) => {
  const invocation: Invocation = {
    taskId: record.id,
    conversationId: record.conversationId,
    mode,
    ended: false,
    fiber: undefined,
    done: Deferred.makeUnsafe<void>(),
  }
  state.invocations.set(record.id, invocation)
  return invocation
}

/** Reserve one candidate, or settle it as `orphaned` when it is aborted and blocked. */
const reserveOne = Effect.fnUntraced(function* (
  state: State,
  tx: Tx,
  record: TaskRecord,
  snapshot: Snapshot,
) {
  const mode = record.abortRequested ? 'abort' : 'run'
  const resolution = yield* resolve(state, record, snapshot)
  if (resolution.kind === 'blocked') {
    // A blocked task without a mark stays live; an aborted one can run no abort handler.
    if (mode === 'abort' && record.abortReason === undefined) {
      yield* terminate(tx, record, { status: 'orphaned', reason: resolution.reason })
    }
    return Option.none<Reservation>()
  }
  const resolved = resolution.record
  if (resolved !== record || record.state.status !== 'running') {
    const checkpoint = 'checkpoint' in resolved.state ? resolved.state.checkpoint : null
    yield* tx.setTask(withState(resolved, { status: 'running', checkpoint }))
  }
  // Registered on the line, so marks and later passes see it; `end` makes it a candidate again.
  state.runnable.delete(record.id)
  const reservation: Reservation = {
    invocation: createInvocation(state, record, mode),
    task: resolution.task,
    snapshot,
  }
  return Option.some(reservation)
})

/**
 * Reserve every eligible task in one commit. A task that cannot be a candidate leaves the
 * runnable set until its record changes or the task it waits for ends; a blocked one stays.
 */
const reserve = (state: State) => {
  const reservations: Array<Reservation> = []
  return state.session
    .commit((tx) =>
      Effect.gen(function* () {
        if (state.closing) return
        let snapshot: Snapshot | undefined
        // Deleting the visited member of a Set does not disturb the iteration.
        for (const id of state.runnable) {
          const record = state.live.get(id)
          const candidate =
            record !== undefined &&
            record.state.status !== 'completing' &&
            !state.invocations.has(id) &&
            !waiting(state, record)
          if (!candidate) {
            state.runnable.delete(id)
            continue
          }
          snapshot ??= yield* state.registry.snapshot
          const reservation = yield* reserveOne(state, tx, record, snapshot)
          if (Option.isSome(reservation)) reservations.push(reservation.value)
        }
      }),
    )
    .pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          for (const { invocation } of reservations) {
            state.invocations.delete(invocation.taskId)
            state.runnable.add(invocation.taskId)
          }
        }),
      ),
      Effect.as(reservations),
    )
}

/** One pass: wait to be woken, then reserve and start every eligible task. */
const pass = (state: State) =>
  Effect.gen(function* () {
    yield* state.wake.await
    state.wake.closeUnsafe()
    for (const reservation of yield* reserve(state)) yield* start(state, reservation)
  })

/**
 * Reserve and start tasks whenever a pass is requested. A failed reservation commit seals the
 * Scheduler: it runs no task code, so it is a storage failure or a bug, and passing again would
 * not fix it.
 */
export const drive = (state: State) =>
  Effect.forever(pass(state)).pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.andThen(report('Scheduler stopped: a reservation failed', cause), seal(state)),
    ),
    Effect.ignore,
  )
