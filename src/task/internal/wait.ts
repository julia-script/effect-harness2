import { Deferred, Effect, Option } from 'effect'
import type { Tx } from '../../session/Session.ts'
import type { StorageError } from '../../storage/StorageError.ts'
import type { TaskId } from '../../storage/schema/Ids.ts'
import type { JoinPolicy, TaskRecord } from '../../storage/schema/Task.ts'
import type { TerminalTask } from '../Task.ts'
import { TaskNotFound, TaskRejected } from '../TaskError.ts'
import type { SchedulerClosed } from '../TaskError.ts'
import { closedError, isTerminal, readsFirst } from './state.ts'
import type { Invocation, State } from './state.ts'

export const notFound = (taskId: TaskId) =>
  new TaskNotFound({ message: `Task ${taskId} does not exist`, taskId })

const rejected = (taskId: TaskId, message: string) => new TaskRejected({ message, taskId })

/** The shared receipt of a live task, created at its first waiter. */
const receiptOf = (state: State, id: TaskId) => {
  const existing = state.receipts.get(id)
  if (existing !== undefined) return existing
  const created = Deferred.makeUnsafe<TerminalTask, SchedulerClosed>()
  state.receipts.set(id, created)
  return created
}

/**
 * Wait for a task's terminal receipt. Checking the task and registering the wait happen on the
 * line, so no terminal commit falls between them; the wait itself runs off the line.
 */
export const waitForTask = (state: State, id: TaskId) =>
  Effect.flatMap(
    readsFirst(
      state.session.commit((tx) =>
        Effect.gen(function* () {
          if (state.closing) return yield* closedError()
          const record = state.live.has(id) ? undefined : yield* tx.task(id)
          if (record !== undefined && isTerminal(record)) return { done: record }
          if (record === undefined && !state.live.has(id)) return yield* notFound(id)
          return { wait: receiptOf(state, id) }
        }),
      ),
    ),
    (found) => ('done' in found ? Effect.succeed(found.done) : Deferred.await(found.wait)),
  )

/** A task record as the commit stages it, as committed, or from Storage. */
const memberOf = (
  state: State,
  staged: ReadonlyMap<TaskId, TaskRecord>,
  id: TaskId,
): Effect.Effect<TaskRecord | undefined, StorageError> => {
  const known = staged.get(id) ?? state.live.get(id)
  return known === undefined ? state.storage.task(id) : Effect.succeed(known)
}

/**
 * The path from a task in `on` back to `task` through durable waits, if the wait would close a
 * cycle. An edge runs from a waiting task that is not abort-marked to each task in its `on`.
 * Owned work adds edges too once ownership is ported.
 */
const waitCycle = (
  state: State,
  task: TaskId,
  on: ReadonlyArray<TaskId>,
  staged: ReadonlyMap<TaskId, TaskRecord>,
): ReadonlyArray<TaskId> | undefined => {
  const from = new Map<TaskId, TaskId | undefined>()
  const pending: Array<TaskId> = []
  const reach = (id: TaskId, via?: TaskId) => {
    if (from.has(id)) return
    from.set(id, via)
    pending.push(id)
  }
  for (const id of on) reach(id)
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === task) {
      const path: Array<TaskId> = []
      for (let at: TaskId | undefined = id; at !== undefined; at = from.get(at)) path.unshift(at)
      return path
    }
    const record = staged.get(id) ?? state.live.get(id)
    if (record?.state.status !== 'waiting' || record.abortRequested) continue
    for (const member of record.state.on) reach(member, id)
  }
  return undefined
}

const waitProblem = Effect.fnUntraced(function* (
  state: State,
  tx: Tx,
  invocation: Invocation,
  on: ReadonlyArray<TaskId>,
  policy: JoinPolicy,
) {
  const id = invocation.taskId
  if (invocation.mode === 'abort') return Option.some(`Abort handler of task ${id} cannot wait`)
  const staged = new Map((yield* tx.stagedTasks).map((record) => [record.id, record]))
  for (const member of on) {
    const record = yield* memberOf(state, staged, member)
    if (record === undefined) return Option.some(`Task ${member} does not exist`)
    if (policy === 'failFast' && record.owner !== id) {
      return Option.some(`Task ${id} can wait failFast only on tasks it owns; ${member} is not one`)
    }
  }
  return Option.map(
    Option.fromNullishOr(waitCycle(state, id, on, staged)),
    (cycle) =>
      `Task ${id} cannot wait on ${cycle[0]}: ${[id, ...cycle].join(' -> ')} is a wait cycle`,
  )
})

/**
 * A wait names existing tasks, and `failFast` only tasks the waiter owns. It may not close a
 * cycle of durable waits, which no task on it could finish first. An abort handler cannot wait.
 */
export const validateWait = (
  state: State,
  tx: Tx,
  invocation: Invocation,
  on: ReadonlyArray<TaskId>,
  policy: JoinPolicy,
) =>
  Effect.flatMap(waitProblem(state, tx, invocation, on, policy), (problem) =>
    Option.isSome(problem) ? Effect.fail(rejected(invocation.taskId, problem.value)) : Effect.void,
  )
