import { Seq } from '../schema/index.ts'
import type {
  ConversationRecord,
  EntryRecord,
  StorageWrite,
  SubmissionRecord,
  TaskRecord,
} from '../schema/index.ts'
import {
  applyDocumentActions,
  checkDocumentActions,
  prepareDocumentActions,
  resolveDocumentCopies,
} from './documents.ts'
import {
  assertOpen,
  freeze,
  getOrCreate,
  insertMapId,
  insertSorted,
  removeSorted,
} from './state.ts'
import type { State, TableName } from './state.ts'

/** The table and ID a write creates or replaces; document changes and retirements claim none. */
const claimOf = (
  write: StorageWrite,
): { readonly table: TableName; readonly id: number } | undefined => {
  if (write.type === 'document.create' || write.type === 'document.copy') {
    return { table: 'document', id: write.record.id }
  }
  if (write.type === 'document.change' || write.type === 'document.retire') return undefined
  return { table: write.type, id: write.value.id }
}

/** Enforce global ID ownership: one table per ID, and immutable records are created once. */
const checkGlobalIds = (state: State, writes: ReadonlyArray<StorageWrite>): void => {
  const claimed = new Map<number, TableName>()
  for (const write of writes) {
    const claim = claimOf(write)
    if (claim === undefined) continue
    const { table, id } = claim
    const existing = state.recordTypes.get(id)
    const earlier = claimed.get(id)
    if (table === 'conversation' || table === 'entry' || table === 'document') {
      if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`)
      if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`)
    } else {
      // Tasks and submissions are replaced as complete records.
      if (existing !== undefined && existing !== table) {
        throw new Error(`ID ${id} already belongs to ${existing}`)
      }
      if (earlier !== undefined && earlier !== table) {
        throw new Error(`ID ${id} is written as two record types`)
      }
    }
    claimed.set(id, table)
  }
}

const claim = (state: State, id: number, table: TableName): void => {
  state.recordTypes.set(id, table)
  state.nextId = Math.max(state.nextId, id + 1)
}

const applyConversation = (state: State, value: ConversationRecord): void => {
  claim(state, value.id, 'conversation')
  state.conversations.set(value.id, value)
  insertSorted(state.conversationIds, value.id)
  if (value.owner !== undefined) {
    insertMapId(state.conversationIdsByOwnerConversation, value.owner.conversationId, value.id)
    insertMapId(state.conversationIdsByOwnerTask, value.owner.taskId, value.id)
  }
}

const applyEntry = (state: State, value: EntryRecord, seq: Seq): void => {
  claim(state, value.id, 'entry')
  state.entries.set(value.id, value)
  state.entryCommitSeqs.set(value.id, seq)
  insertMapId(state.entryIds, value.conversationId, value.id)
  if (value.head !== undefined) insertMapId(state.headEntryIds, value.conversationId, value.id)
}

const applyTask = (state: State, value: TaskRecord): void => {
  claim(state, value.id, 'task')
  const previous = state.tasks.get(value.id)
  if (previous === undefined) {
    insertSorted(state.taskIds, value.id)
    insertSorted(state.taskIdsByStatus[value.state.status], value.id)
  } else if (previous.state.status !== value.state.status) {
    removeSorted(state.taskIdsByStatus[previous.state.status], value.id)
    insertSorted(state.taskIdsByStatus[value.state.status], value.id)
  }
  state.tasks.set(value.id, value)
}

const unindexRequest = (state: State, previous: SubmissionRecord): void => {
  if (previous.requestId === undefined) return
  const requests = state.submissionIdsByRequest.get(previous.conversationId)
  if (requests?.get(previous.requestId) !== previous.id) return
  requests.delete(previous.requestId)
  if (requests.size === 0) state.submissionIdsByRequest.delete(previous.conversationId)
}

const applySubmission = (state: State, value: SubmissionRecord): void => {
  claim(state, value.id, 'submission')
  const previous = state.submissions.get(value.id)
  if (previous === undefined) {
    insertSorted(state.submissionIds, value.id)
    insertSorted(state.submissionIdsByStatus[value.status], value.id)
  } else {
    if (previous.status !== value.status) {
      removeSorted(state.submissionIdsByStatus[previous.status], value.id)
      insertSorted(state.submissionIdsByStatus[value.status], value.id)
    }
    unindexRequest(state, previous)
  }
  state.submissions.set(value.id, value)
  if (value.requestId !== undefined) {
    getOrCreate(state.submissionIdsByRequest, value.conversationId, () => new Map()).set(
      value.requestId,
      value.id,
    )
  }
}

const applyRecord = (state: State, write: StorageWrite, seq: Seq): void => {
  switch (write.type) {
    case 'conversation':
      applyConversation(state, write.value)
      break
    case 'entry':
      applyEntry(state, write.value, seq)
      break
    case 'task':
      applyTask(state, write.value)
      break
    case 'submission':
      applySubmission(state, write.value)
      break
    case 'document.copy':
      throw new Error('Prepared document copy was not resolved')
    case 'document.create':
    case 'document.change':
    case 'document.retire':
      break
  }
}

/**
 * Atomically persist one batch. Everything that can reject the batch runs before the first state
 * change, so a rejected batch has no effect.
 */
export const commit = (state: State, writes: ReadonlyArray<StorageWrite>): Seq => {
  assertOpen(state)
  const seq = Seq.make(state.nextSeq)
  const detached = freeze(resolveDocumentCopies(state, structuredClone(writes)))
  checkGlobalIds(state, detached)
  const documentActions = prepareDocumentActions(detached)
  checkDocumentActions(state, documentActions)

  for (const write of detached) applyRecord(state, write, seq)
  applyDocumentActions(state, documentActions, seq)
  state.nextSeq = seq + 1
  return seq
}
