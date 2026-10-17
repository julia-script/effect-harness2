import { Effect } from 'effect'
import type { Schema } from 'effect'
import { cast } from 'effect/Function'
import type { Tx } from '../../session/Session.ts'
import type { TaskRecord, TaskOutcome } from '../../storage/schema/Task.ts'
import type * as Task from '../Task.ts'
import { InvocationEnded, TaskRejected } from '../TaskError.ts'
import type { SchedulerClosed } from '../TaskError.ts'
import { closedError, isTerminal, memoOf, withMemo, withState } from './state.ts'
import type { Invocation, State } from './state.ts'
import { validateWait, waitForTask } from './wait.ts'

type ErasedRuntime = Task.Runtime<Schema.Json, Task.Checkpoint, Schema.Json>
type ErasedNext = Task.NextState<Task.Checkpoint, Schema.Json>

/** A state the change returned; nothing is `undefined`. */
const isNextState = (value: ErasedNext | void): value is ErasedNext =>
  typeof value === 'object' && value !== null

const endedError = (invocation: Invocation) =>
  new InvocationEnded({
    message: `Task ${invocation.taskId} invocation has ended`,
    taskId: invocation.taskId,
  })

const rejected = (invocation: Invocation, message: string) =>
  new TaskRejected({ message: `Task ${invocation.taskId} ${message}`, taskId: invocation.taskId })

/** Run `effect` unless the invocation has ended. */
const live = <A, E>(invocation: Invocation, effect: Effect.Effect<A, E>) =>
  Effect.suspend((): Effect.Effect<A, E | InvocationEnded> =>
    invocation.ended ? Effect.fail(endedError(invocation)) : effect,
  )

type Refusal = InvocationEnded | SchedulerClosed | TaskRejected

/** Why a runtime commit is refused, read on the line; `undefined` admits it. */
const gate = (
  state: State,
  invocation: Invocation,
  found: TaskRecord | undefined,
): Refusal | undefined => {
  if (invocation.ended) return endedError(invocation)
  if (state.closing) return closedError()
  if (found === undefined) return rejected(invocation, 'is terminal')
  if (found.state.status !== 'running') return rejected(invocation, `is ${found.state.status}`)
  return invocation.mode === 'run' && found.abortRequested
    ? rejected(invocation, 'has a durable abort mark')
    : undefined
}

/**
 * Commit after rereading the task on the line and gating the invocation. The commit is bound to
 * the task, so its entries record it and its new tasks default to its conversation.
 */
export const gated = <A, E>(
  state: State,
  invocation: Invocation,
  change: (tx: Tx, current: TaskRecord) => Effect.Effect<A, E>,
) =>
  live(
    invocation,
    state.session.commit(
      (tx) =>
        Effect.suspend((): Effect.Effect<A, E | Refusal> => {
          const found = state.live.get(invocation.taskId)
          const refused = gate(state, invocation, found)
          return refused !== undefined || found === undefined
            ? Effect.fail(refused ?? endedError(invocation))
            : change(tx, found)
        }),
      { conversationId: invocation.conversationId, taskId: invocation.taskId },
    ),
  )

/** Replace the running task's state with what it committed; a wait is validated first. */
const commitState = Effect.fnUntraced(function* (
  state: State,
  invocation: Invocation,
  tx: Tx,
  current: TaskRecord,
  next: ErasedNext,
) {
  if (next.status === 'waiting') yield* validateWait(state, tx, invocation, next.on, next.policy)
  yield* tx.setTask(withState(current, next))
})

const outcomes = (state: State, invocation: Invocation, ids: ReadonlyArray<TaskRecord['id']>) =>
  live(
    invocation,
    state.session.commit((tx) =>
      Effect.forEach(ids, (id) =>
        Effect.flatMap(tx.task(id), (record) =>
          record !== undefined && isTerminal(record)
            ? Effect.succeed<TaskOutcome>(record.state.outcome)
            : Effect.fail(rejected(invocation, `cannot read task ${id}: it is not terminal`)),
        ),
      ),
    ),
  )

/** The runtime of one invocation, with its definition's types erased. */
export const makeRuntime = (state: State, invocation: Invocation): ErasedRuntime => ({
  taskId: invocation.taskId,
  conversationId: invocation.conversationId,
  commit: (change) =>
    gated(state, invocation, (tx, current) =>
      Effect.flatMap(change(tx, cast(current)), (next) =>
        isNextState(next) ? commitState(state, invocation, tx, current, next) : Effect.void,
      ),
    ),
  memo: (name, candidate) =>
    gated(state, invocation, (tx, current) => {
      const winner = memoOf(current, name)
      if (winner !== undefined) return Effect.succeed(cast<Schema.Json, typeof candidate>(winner))
      return Effect.as(tx.setTask(withMemo(current, name, candidate)), candidate)
    }),
  readMemo: (name) =>
    live(
      invocation,
      Effect.sync(() => memoOf(state.live.get(invocation.taskId), name)),
    ),
  getTask: (id) =>
    live(
      invocation,
      state.session.commit((tx) => tx.task(id)),
    ),
  waitForTask: (id) => live(invocation, waitForTask(state, id)),
  outcomes: (ids) => outcomes(state, invocation, ids),
  snapshot: state.session.snapshot,
  snapshotAsOf: state.session.snapshotAsOf,
  watchDoc: state.session.watchDoc,
  documentState: state.session.documentState,
})
