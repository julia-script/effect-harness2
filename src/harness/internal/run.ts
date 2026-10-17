/**
 * Run control in `pi.live` (spec §6, §8): a run is the task holding `pi.live.run`, which settles
 * the run's inputs when it ends. The built-in generation task drives it through these helpers.
 */
import { Effect } from 'effect'
import type { Draft } from '../../delta/Tracker.ts'
import type { SubmissionSettlement, TaskKind, Tx } from '../../session/Session.ts'
import type { ConversationId, EntryId, SubmissionId, TaskId } from '../../storage/schema/Ids.ts'
import type { TaskRecord } from '../../storage/schema/Task.ts'
import type { SchedulerOutcome } from '../../task/Scheduler.ts'
import * as Live from '../Live.ts'
import { applyBoundary } from './inbox.ts'
import type { Boundary } from './inbox.ts'

/** The task kind that takes `pi.live.run`: the built-in generation task. */
export const RUN_KIND = 'pi.generation'

/** What `Tx.createTask()` needs of the run task: the generation's first checkpoint. */
export const runTask: TaskKind<Record<string, never>> = {
  name: RUN_KIND,
  version: 1,
  initial: () => ({ phase: 'prepare', attempt: 1 }),
}

/** A run task owned by its conversation. */
const createRunTask = (tx: Tx, conversationId: ConversationId) =>
  tx.createTask(runTask, {}, { ownership: { kind: 'conversation' }, conversationId })

/** Start a run for placed input submissions: a new run task takes `pi.live.run`. */
export const startRun = Effect.fnUntraced(function* (
  tx: Tx,
  conversationId: ConversationId,
  live: Draft<Live.State>,
  inputs: ReadonlyArray<SubmissionId>,
) {
  live.run = { taskId: yield* createRunTask(tx, conversationId), inputs: [...inputs] }
})

/** End the run `taskId` owns: settle each of its inputs and remove `run`. */
export const endRun = Effect.fnUntraced(function* (
  tx: Tx,
  live: Draft<Live.State>,
  taskId: TaskId,
  settlement: SubmissionSettlement,
) {
  const run = live.run
  if (run?.taskId !== taskId) return
  for (const id of run.inputs) yield* tx.settleSubmission(id, settlement)
  delete live.run
})

/** Hand run control from `from` to `to`; the run's inputs move with it. */
export const handOver = (live: Draft<Live.State>, from: TaskId, to: TaskId): void => {
  if (live.run?.taskId === from) live.run.taskId = to
}

/**
 * A final answer (spec §6): the final boundary places queued items, the run's inputs settle
 * `done` with `answer`, and the user items it placed start the next run. The caller prepares the
 * boundary at the start of its commit, before it appends the answer.
 */
export const finishRun = Effect.fnUntraced(function* (
  tx: Tx,
  boundary: Boundary,
  taskId: TaskId,
  answer: EntryId,
) {
  const { conversationId } = boundary
  const live = yield* tx.doc(Live.document, conversationId)
  const { users } = yield* applyBoundary(tx, boundary, 'final')
  yield* endRun(tx, live, taskId, { status: 'done', answer })
  if (users.length > 0) yield* startRun(tx, conversationId, live, users)
})

/**
 * The `postTools` boundary after a tool round (spec §8.5): placed steers join the run, which a
 * fresh run task takes over. A queued reset cuts the run's context instead: the run ends
 * `unanswered` with reason `reset`, and the user items placed after it start the next run.
 * Returns the task that holds the run now, if any.
 */
export const continueRun = Effect.fnUntraced(function* (
  tx: Tx,
  boundary: Boundary,
  taskId: TaskId,
) {
  const { conversationId } = boundary
  const live = yield* tx.doc(Live.document, conversationId)
  const { users, reset } = yield* applyBoundary(tx, boundary, 'postTools')
  if (reset) {
    yield* endRun(tx, live, taskId, { status: 'unanswered', reason: 'reset' })
    if (users.length > 0) yield* startRun(tx, conversationId, live, users)
    return live.run?.taskId
  }
  if (live.run?.taskId !== taskId) return live.run?.taskId
  live.run.inputs.push(...users)
  const next = yield* createRunTask(tx, conversationId)
  handOver(live, taskId, next)
  return next
})

/**
 * Cleanup for an outcome the scheduler writes itself (spec §5.4): a faulted or orphaned run task
 * ends its run `unanswered`. Other kinds are left alone, so it never creates `pi.live` elsewhere.
 */
export const settleOutcome = Effect.fnUntraced(function* (
  tx: Tx,
  record: TaskRecord,
  outcome: SchedulerOutcome,
) {
  if (record.kind !== RUN_KIND) return
  const live = yield* tx.doc(Live.document, record.conversationId)
  const settlement: SubmissionSettlement =
    outcome.status === 'faulted'
      ? { status: 'unanswered', reason: 'faulted', detail: outcome.error.message }
      : { status: 'unanswered', reason: outcome.reason }
  yield* endRun(tx, live, record.id, settlement)
})
