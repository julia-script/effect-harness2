/* oxlint-disable effecttsgo/any-unknown-in-error-context -- task code may fail with anything, and a failure of any type faults its task */
import { Cause, Deferred, Effect, Latch } from 'effect'
import { cast } from 'effect/Function'
import type { Fiber, Schema, Scope } from 'effect'
import type { Service as SessionService } from '../../session/Session.ts'
import type { Service as StorageService } from '../../storage/Storage.ts'
import type { ConversationId, TaskId } from '../../storage/schema/Ids.ts'
import type { TaskRecord, TaskState } from '../../storage/schema/Task.ts'
import type { Service as RegistryService, Snapshot } from '../Registry.ts'
import type * as Task from '../Task.ts'
import { ReadAfterWrite } from '../../session/SessionError.ts'
import { SchedulerClosed } from '../TaskError.ts'

/** One in-memory execution of a task: its phases in run mode, or its abort handler. */
export interface Invocation {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly mode: 'run' | 'abort'
  /** Set on the line by the step that ends it, or when its fiber exits. */
  ended: boolean
  /** Set once the fiber is forked, just after the reservation commit. */
  fiber: Fiber.Fiber<void> | undefined
  /** Completes when the fiber has exited. */
  readonly done: Deferred.Deferred<void>
}

/**
 * The Scheduler's in-memory state. `live` mirrors every committed non-terminal task: the commit
 * listener updates it on the Session line, so code on the line reads exactly the committed state.
 * Every task transition is decided by one callback on the line.
 */
export interface State {
  readonly session: SessionService
  /** Committed reads on the line inside a commit, after its table writes. */
  readonly storage: StorageService
  readonly registry: RegistryService
  /** Where invocation fibers run; closing it interrupts them. */
  readonly scope: Scope.Closeable
  readonly live: Map<TaskId, TaskRecord>
  readonly invocations: Map<TaskId, Invocation>
  /** Live tasks the next reservation pass considers; ones found waiting leave it. */
  readonly runnable: Set<TaskId>
  /** Waiting tasks by each task in their `on`. */
  readonly waiters: Map<TaskId, Set<TaskId>>
  /** Terminal receipts awaited by `waitForTask`, by task. */
  readonly receipts: Map<TaskId, Deferred.Deferred<Task.TerminalTask, SchedulerClosed>>
  /** The definition whose migration failed, per task; retried only for another definition. */
  readonly failedMigrations: Map<TaskId, Erased>
  /** Opened to request a reservation pass. */
  readonly wake: Latch.Latch
  closing: boolean
}

export const makeState = (
  session: SessionService,
  storage: StorageService,
  registry: RegistryService,
  scope: Scope.Closeable,
): State => ({
  session,
  storage,
  registry,
  scope,
  live: new Map(),
  invocations: new Map(),
  runnable: new Set(),
  waiters: new Map(),
  receipts: new Map(),
  failedMigrations: new Map(),
  wake: Latch.makeUnsafe(false),
  closing: false,
})

/** Request a reservation pass. */
export const kick = (state: State): void => {
  state.wake.openUnsafe()
}

export const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
  const values = map.get(key)
  if (values === undefined) map.set(key, new Set([value]))
  else values.add(value)
}

const deleteFrom = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
  const values = map.get(key)
  if (values === undefined) return
  values.delete(value)
  if (values.size === 0) map.delete(key)
}

/** Whether a record is terminal, typed as the receipt. */
export const isTerminal = (record: TaskRecord): record is Task.TerminalTask =>
  record.state.status === 'terminal'

/**
 * Bring the state in line with a task's committed record. A task that ended frees the tasks
 * waiting on it.
 */
export const track = (state: State, previous: TaskRecord | undefined, record: TaskRecord): void => {
  const id = record.id
  if (previous?.state.status === 'waiting') {
    for (const on of previous.state.on) deleteFrom(state.waiters, on, id)
  }
  if (isTerminal(record)) {
    state.live.delete(id)
    state.runnable.delete(id)
    state.failedMigrations.delete(id)
    for (const waiter of state.waiters.get(id) ?? []) state.runnable.add(waiter)
    return
  }
  state.live.set(id, record)
  if (record.state.status === 'completing') state.runnable.delete(id)
  else state.runnable.add(id)
  if (record.state.status === 'waiting') {
    for (const on of record.state.on) addTo(state.waiters, on, id)
  }
}

/** End an invocation: its runtime operations fail from now on, and its task is free. */
export const end = (state: State, invocation: Invocation): void => {
  if (invocation.ended) return
  invocation.ended = true
  if (state.invocations.get(invocation.taskId) === invocation) {
    state.invocations.delete(invocation.taskId)
    if (state.live.has(invocation.taskId)) state.runnable.add(invocation.taskId)
  }
  kick(state)
}

/** A record's fields besides its state and memos. */
const fieldsOf = (record: TaskRecord) => {
  if ('memos' in record) {
    const { state: _state, memos: _memos, ...fields } = record
    return fields
  }
  const { state: _state, ...fields } = record
  return fields
}

/** Replace a live record's state; memos disappear once an outcome is decided. */
export const withState = (record: TaskRecord, next: TaskState): TaskRecord => {
  if (next.status === 'terminal' || next.status === 'completing') {
    return { ...fieldsOf(record), state: next }
  }
  const memos = 'memos' in record ? record.memos : undefined
  return { ...fieldsOf(record), ...(memos === undefined ? {} : { memos }), state: next }
}

/** The record with an abort request's mark, which replaces a `restart` mark. */
export const withAbortMark = (record: TaskRecord): TaskRecord => {
  const { abortReason: _reason, ...rest } = record
  return { ...rest, abortRequested: true }
}

/** Own memo entry only: a name such as `toString` must not resolve to an inherited property. */
export const memoOf = (record: TaskRecord | undefined, name: string): Schema.Json | undefined => {
  const memos = record !== undefined && 'memos' in record ? record.memos : undefined
  return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined
}

/** Structural equality of two JSON values; object key order is ignored. */
export const jsonEqual = (left: Schema.Json, right: Schema.Json): boolean => {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    const rightArray = cast<Schema.Json, ReadonlyArray<Schema.Json>>(right)
    return left.every((value: Schema.Json, index) => jsonEqual(value, rightArray[index] ?? null))
  }
  // Neither is an array: both are objects.
  const leftObject = cast<Schema.Json, Record<string, Schema.Json>>(left)
  const rightObject = cast<Schema.Json, Record<string, Schema.Json>>(right)
  const keys = Object.keys(leftObject)
  if (keys.length !== Object.keys(rightObject).length) return false
  return keys.every(
    (key) =>
      Object.hasOwn(rightObject, key) &&
      jsonEqual(leftObject[key] ?? null, rightObject[key] ?? null),
  )
}

/** The message of a failure, for a `faulted` outcome. */
export const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : Cause.pretty(cause)
}

/** Report a non-fatal failure. */
export const report = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.logError(message, cause)

/** Complete the receipt waits of a task that became terminal. */
export const resolveReceipt = (state: State, record: TaskRecord) =>
  Effect.suspend(() => {
    const receipt = state.receipts.get(record.id)
    if (receipt === undefined || !isTerminal(record)) return Effect.void
    state.receipts.delete(record.id)
    return Deferred.succeed(receipt, record)
  })

/**
 * Run task code and capture how it ended. Task code may fail with anything: a failure of any
 * type faults its task, or blocks a migration.
 */
export const runTaskCode = <A>(code: () => Effect.Effect<A, unknown>) =>
  Effect.exit(Effect.suspend(code))

/** The record with `value` as its memo `name`; settled records hold no memos. */
export const withMemo = (record: TaskRecord, name: string, value: Schema.Json): TaskRecord => {
  const memos = 'memos' in record ? record.memos : undefined
  const state = record.state
  if (state.status === 'terminal' || state.status === 'completing') return record
  return { ...fieldsOf(record), memos: { ...memos, [name]: value }, state }
}

export const closedError = () => new SchedulerClosed({ message: 'Scheduler is closed' })

/** Stop scheduling: no phase starts any more, and every receipt wait fails. */
export const seal = (state: State) =>
  Effect.suspend(() => {
    state.closing = true
    const receipts = [...state.receipts.values()]
    state.receipts.clear()
    return Effect.forEach(receipts, (receipt) => Deferred.fail(receipt, closedError()), {
      discard: true,
    })
  })

/**
 * A commit whose callback reads tables only before writing cannot fail with `ReadAfterWrite`;
 * if it does, that is a bug.
 */
export const readsFirst = <A, E, R>(effect: Effect.Effect<A, E | ReadAfterWrite, R>) =>
  Effect.catchIf(
    effect,
    (error): error is ReadAfterWrite => error instanceof ReadAfterWrite,
    Effect.die,
  )

/** A definition with its types erased, as the scheduler runs it. */
export type Erased = Task.Task<Schema.Json, Task.Checkpoint, Schema.Json>

/** Every `Task.Any` was made by `Task.make`, so it is a whole definition. */
export const erase = (task: Task.Any): Erased => cast(task)

/** The definition a snapshot holds for a task kind. */
export const lookup = (snapshot: Snapshot, kind: string): Erased | undefined => {
  const task = snapshot.get(kind)
  return task === undefined ? undefined : erase(task)
}
