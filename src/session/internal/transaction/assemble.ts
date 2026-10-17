import { Effect } from 'effect'
import type { DocumentRecord } from '../../../storage/schema/Document.ts'
import type { ConversationId, Seq, TaskId } from '../../../storage/schema/Ids.ts'
import type { TaskRecord } from '../../../storage/schema/Task.ts'
import type { StorageWrite } from '../../../storage/schema/Write.ts'
import type { CommitChange, CommitPublication } from '../../Session.ts'
import { scanDocuments } from './conversations.ts'
import { committedTask, currentTask, rejected } from './state.ts'
import type { TxState } from './state.ts'
import { resolveSubmissions } from './submissions.ts'

/** A document retired because its task became terminal. */
interface Retirement {
  readonly record: DocumentRecord
  readonly conversationId: ConversationId
}

/** The batch of one transaction, and what its publication needs beyond the writes. */
export interface Assembly {
  readonly writes: ReadonlyArray<StorageWrite>
  readonly retirements: ReadonlyArray<Retirement>
}

/**
 * New owned work needs a live owner, judged on the owner's final candidate: not `completing`,
 * terminal, or abort-marked. A task cannot create owned work in the commit that finishes it.
 */
const validateOwners = (state: TxState) => {
  const owners: Array<{ readonly what: string; readonly taskId: TaskId }> = []
  for (const write of state.writes) {
    if (write.type !== 'conversation' || write.value.owner === undefined) continue
    owners.push({ what: 'Conversation owner task', taskId: write.value.owner.taskId })
  }
  for (const task of state.tasks.values()) {
    const record = task.write?.kind === 'create' ? task.write.record : undefined
    if (record?.owner !== undefined) owners.push({ what: 'Task owner', taskId: record.owner })
  }
  return Effect.forEach(
    owners,
    ({ what, taskId }) =>
      Effect.flatMap(currentTask(state, taskId), (task) => {
        const problem = ownerProblem(task)
        return problem === undefined ? Effect.void : rejected(`${what} ${taskId} ${problem}`)
      }),
    { discard: true },
  )
}

const ownerProblem = (task: TaskRecord | undefined): string | undefined => {
  if (task === undefined) return 'does not exist'
  const status = task.state.status
  if (status === 'terminal' || status === 'completing') return `is ${status}`
  return task.abortRequested ? 'is abort-marked' : undefined
}

const replacementProblem = (committed: TaskRecord | undefined, record: TaskRecord) => {
  if (committed === undefined) return 'does not exist'
  if (committed.state.status === 'terminal') return 'is already terminal'
  return committed.conversationId === record.conversationId
    ? undefined
    : 'cannot change conversations'
}

/** A replaced task must exist, be live, and stay in its conversation. */
const validateReplacements = (state: TxState) =>
  Effect.forEach(
    state.tasks,
    ([id, task]) => {
      const write = task.write
      if (write?.kind !== 'replace') return Effect.void
      return Effect.flatMap(committedTask(state, id), (committed) => {
        const problem = replacementProblem(committed, write.record)
        return problem === undefined ? Effect.void : rejected(`Task ${id} ${problem}`)
      })
    },
    { discard: true },
  )

/** Terminal settlement retires every current document of the task. */
const terminalRetirements = Effect.fnUntraced(function* (state: TxState) {
  const retirements: Array<Retirement> = []
  for (const [taskId, task] of state.tasks) {
    const write = task.write
    // A task created in this transaction has no committed documents yet.
    if (write?.kind !== 'replace' || write.record.state.status !== 'terminal') continue
    const scope = { kind: 'task' as const, taskId }
    for (const record of yield* scanDocuments(state, scope, 'current')) {
      retirements.push({ record, conversationId: write.record.conversationId })
    }
  }
  return retirements
})

/** Validate everything staged and assemble the atomic batch. */
export const assemble = Effect.fnUntraced(function* (state: TxState) {
  yield* validateOwners(state)
  yield* validateReplacements(state)
  const retirements = yield* terminalRetirements(state)
  yield* resolveSubmissions(state)
  const writes: Array<StorageWrite> = [...state.writes]
  for (const value of state.submissions.values()) writes.push({ type: 'submission', value })
  for (const task of state.tasks.values()) {
    if (task.write !== undefined) writes.push({ type: 'task', value: task.write.record })
  }
  for (const { record, source } of state.forkCopies) {
    writes.push({ type: 'document.copy', record, source })
  }
  for (const { record } of retirements) writes.push({ type: 'document.retire', id: record.id })
  const assembly: Assembly = { writes, retirements }
  return assembly
})

/** The publication of an assembled batch that committed as `seq`. */
export const publication = (state: TxState, assembly: Assembly, seq: Seq): CommitPublication => {
  const changes: Array<CommitChange> = []
  for (const write of assembly.writes) {
    if (
      write.type === 'conversation' ||
      write.type === 'entry' ||
      write.type === 'task' ||
      write.type === 'submission'
    ) {
      changes.push(write)
    }
  }
  for (const { record, source } of state.forkCopies) {
    const conversationId = record.scope.conversationId
    changes.push({
      type: 'document.copy',
      record: { ...record, createdAt: seq },
      conversationId,
      source,
    })
  }
  for (const { record, conversationId } of assembly.retirements) {
    changes.push({
      type: 'document',
      record: { ...record, retiredAt: seq },
      conversationId,
      version: undefined,
      value: null,
      ops: [],
    })
  }
  return { seq, changes }
}
