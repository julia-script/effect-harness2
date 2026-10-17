import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { DocumentId, EntryId, SubmissionId, TaskId } from '../schema/index.ts'
import type { ConversationId, DocumentCreate, SubmissionRecord } from '../schema/index.ts'
import type { StorageService } from '../Storage.ts'
import { createRoot, entryWrite, ids, pendingTask, withStorage } from './test-support.ts'

interface TaskScope {
  readonly kind: 'task'
  readonly taskId: TaskId
}

const base = { kind: 'base', version: 1, value: {} } as const

/** Documents at distinct addresses whose keys look like prototype members. */
const addressRecords = (storage: StorageService, rootId: ConversationId, taskScope: TaskScope) =>
  Effect.gen(function* () {
    const session = { kind: 'session' } as const
    const first: DocumentCreate = {
      id: yield* storage.mintId(DocumentId),
      kind: 'cache',
      scope: session,
      key: '__proto__',
    }
    const second: DocumentCreate = {
      ...first,
      id: yield* storage.mintId(DocumentId),
      key: 'constructor',
    }
    const conversation: DocumentCreate = {
      id: yield* storage.mintId(DocumentId),
      kind: 'cache',
      scope: { kind: 'conversation', conversationId: rootId },
      history: 'latest',
      fork: 'current',
      key: '__proto__',
    }
    const singleton: DocumentCreate = {
      id: yield* storage.mintId(DocumentId),
      kind: 'task.cache',
      scope: taskScope,
    }
    const member: DocumentCreate = {
      ...singleton,
      id: yield* storage.mintId(DocumentId),
      key: 'member',
    }
    const other: DocumentCreate = {
      id: yield* storage.mintId(DocumentId),
      kind: 'task.other',
      scope: taskScope,
    }
    return { first, second, conversation, singleton, member, other }
  })

test('indexes logical addresses and exact-scope scans independently', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const taskId = yield* storage.mintId(TaskId)
      const taskScope = { kind: 'task', taskId } as const
      const records = yield* addressRecords(storage, rootId, taskScope)
      const { first, second, conversation, singleton, member } = records
      yield* storage.commit([
        { type: 'task', value: pendingTask(taskId, rootId) },
        ...Object.values(records).map(
          (record) => ({ type: 'document.create', record, content: base }) as const,
        ),
      ])

      const session = { kind: 'session' } as const
      const proto = { kind: 'cache', scope: session, key: '__proto__' }
      expect((yield* storage.findDocument(proto, 'current'))?.id).toBe(first.id)
      const page = yield* storage.scanDocuments({ scope: session, at: 'current' }, 1)
      const next = yield* storage.scanDocuments({ scope: session, at: 'current' }, 1, page.next)
      expect([...ids(page), ...ids(next)]).toEqual([first.id, second.id])
      const conversationScope = { kind: 'conversation', conversationId: rootId } as const
      const inConversation = { scope: conversationScope, at: 'current' } as const
      expect(ids(yield* storage.scanDocuments(inConversation, 10))).toEqual([conversation.id])
      const taskCache = { kind: 'task.cache', scope: taskScope }
      expect((yield* storage.findDocument(taskCache, 'current'))?.id).toBe(singleton.id)
      expect((yield* storage.findDocument({ ...taskCache, key: 'member' }, 'current'))?.id).toBe(
        member.id,
      )
      const byKind = { scope: taskScope, at: 'current', kind: 'task.cache' } as const
      expect(ids(yield* storage.scanDocuments(byKind, 10))).toEqual([singleton.id, member.id])
    }),
  ))

test('gives create-plus-retire an empty lifetime and rejects a second current incarnation', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const record = {
        id: yield* storage.mintId(DocumentId),
        kind: 'one',
        scope: { kind: 'session' },
      } as const
      yield* storage.commit([{ type: 'document.create', record, content: base }])
      const duplicate = yield* Effect.flip(
        storage.commit([
          {
            type: 'document.create',
            record: { ...record, id: yield* storage.mintId(DocumentId) },
            content: base,
          },
        ]),
      )
      expect(duplicate.message).toBe('Document address already has a current incarnation')

      const empty: DocumentCreate = {
        id: yield* storage.mintId(DocumentId),
        kind: 'one',
        key: 'empty',
        scope: { kind: 'conversation', conversationId: rootId },
        history: 'rewindable',
        fork: 'initial',
      }
      const emptyAt = yield* storage.commit([
        { type: 'document.create', record: empty, content: base },
        { type: 'document.retire', id: empty.id },
      ])
      expect(yield* storage.document(empty.id, 'current')).toBeUndefined()
      expect(yield* storage.document(empty.id, emptyAt)).toBeUndefined()
      const address = { kind: 'one', scope: empty.scope, key: 'empty' }
      expect(yield* storage.findDocument(address, emptyAt)).toBeUndefined()
    }),
  ))

test('rolls back record tables and secondary indexes when a document command fails', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const task = pendingTask(yield* storage.mintId(TaskId), rootId)
      const submission: SubmissionRecord = {
        id: yield* storage.mintId(SubmissionId),
        conversationId: rootId,
        requestId: 'atomic',
        type: 'input',
        status: 'queued',
      }
      const record = {
        id: yield* storage.mintId(DocumentId),
        kind: 'atomic',
        scope: { kind: 'session' },
      } as const
      yield* storage.commit([
        { type: 'task', value: task },
        { type: 'submission', value: submission },
        { type: 'document.create', record, content: base },
      ])
      const entryId = yield* storage.mintId(EntryId)
      yield* Effect.flip(
        storage.commit([
          { type: 'task', value: { ...task, state: { status: 'running', checkpoint: {} } } },
          { type: 'submission', value: { ...submission, status: 'unanswered', reason: 'failed' } },
          entryWrite(entryId, rootId, 'transient'),
          {
            type: 'document.create',
            record: { ...record, id: yield* storage.mintId(DocumentId) },
            content: base,
          },
        ]),
      )
      expect(ids(yield* storage.scanTasks({ status: 'pending' }, 10))).toEqual([task.id])
      expect(ids(yield* storage.scanTasks({ status: 'running' }, 10))).toEqual([])
      expect(yield* storage.submissionByRequest(rootId, 'atomic')).toEqual(submission)
      expect(yield* storage.entry(entryId)).toBeUndefined()
      expect(ids(yield* storage.scanEntries({ conversationId: rootId }, 10))).toEqual([])
    }),
  ))
