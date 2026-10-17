import { expect, test } from 'bun:test'
import { Effect, Exit, Schema } from 'effect'
import { make } from '../memory.ts'
import { StorageError } from '../StorageError.ts'
import {
  ConversationId,
  EntryId,
  ROOT_CONVERSATION_ID,
  SubmissionId,
  TaskId,
} from '../schema/index.ts'
import type { SubmissionRecord, TaskRecord } from '../schema/index.ts'
import { createRoot, entry, entryWrite, ids, pendingTask, withStorage } from './test-support.ts'

test('reserves ID 1 for the immutable root conversation', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      expect(yield* storage.mintId(ConversationId)).toBe(ConversationId.make(2))
      expect(yield* createRoot(storage)).toBe(ROOT_CONVERSATION_ID)
      expect(yield* storage.conversation(ROOT_CONVERSATION_ID)).toEqual({
        id: ROOT_CONVERSATION_ID,
      })
      const error = yield* Effect.flip(
        storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }]),
      )
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toBe('ID 1 already belongs to conversation')
    }),
  ))

test('commits mixed writes atomically and rolls all of them back on failure', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const entryId = yield* storage.mintId(EntryId)
      const task = pendingTask(yield* storage.mintId(TaskId), rootId)
      const input: SubmissionRecord = {
        id: yield* storage.mintId(SubmissionId),
        conversationId: rootId,
        requestId: 'request-1',
        type: 'input',
        status: 'placed',
        entry: entryId,
      }
      const seq = yield* storage.commit([
        entryWrite(entryId, rootId, 'user', { data: { text: 'hello' } }),
        { type: 'task', value: task },
        { type: 'submission', value: input },
      ])
      expect(yield* storage.entry(entryId)).toEqual({
        entry: entry(entryId, rootId, 'user', { data: { text: 'hello' } }),
        commitSeq: seq,
      })

      const transientId = yield* storage.mintId(EntryId)
      const error = yield* Effect.flip(
        storage.commit([
          { type: 'task', value: { ...task, state: { status: 'running', checkpoint: {} } } },
          { type: 'submission', value: { ...input, status: 'done', answer: transientId } },
          entryWrite(transientId, rootId, 'assistant'),
          { type: 'conversation', value: { id: rootId } },
        ]),
      )
      expect(error.message).toBe('ID 1 already belongs to conversation')
      expect(yield* storage.task(task.id)).toEqual(task)
      expect(yield* storage.submission(input.id)).toEqual(input)
      expect(yield* storage.entry(transientId)).toBeUndefined()
      const after = yield* storage.commit([
        entryWrite(yield* storage.mintId(EntryId), rootId, 'after-rollback'),
      ])
      expect(after).toBeGreaterThan(seq)
    }),
  ))

test('detaches retained writes and every returned record', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const entryId = yield* storage.mintId(EntryId)
      const data = { nested: [1, 2] }
      const checkpoint = { nested: { count: 1 } }
      const task: TaskRecord = {
        ...pendingTask(yield* storage.mintId(TaskId), rootId),
        state: { status: 'pending', checkpoint },
      }
      yield* storage.commit([
        entryWrite(entryId, rootId, 'note', { data }),
        { type: 'task', value: task },
      ])

      data.nested.push(3)
      checkpoint.nested.count = 2
      expect((yield* storage.entry(entryId))?.entry.data).toEqual({ nested: [1, 2] })
      const read = yield* storage.task(task.id)
      expect(read?.state).toEqual({ status: 'pending', checkpoint: { nested: { count: 1 } } })

      const readData = (yield* storage.entry(entryId))?.entry.data
      if (Array.isArray(readData)) readData.push(9)
      expect((yield* storage.entry(entryId))?.entry.data).toEqual({ nested: [1, 2] })
    }),
  ))

test('detaches prototype-like JSON keys without changing object prototypes', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const entryId = yield* storage.mintId(EntryId)
      const data = yield* Schema.decodeUnknownEffect(Schema.Json)(
        JSON.parse('{"__proto__":{"polluted":false},"constructor":"stored"}'),
      )
      yield* storage.commit([entryWrite(entryId, rootId, 'note', { data })])
      const read = (yield* storage.entry(entryId))?.entry.data ?? null
      if (typeof read !== 'object' || read === null) throw new Error('Expected an object')
      expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
      expect(Object.hasOwn(read, '__proto__')).toBe(true)
      expect(Reflect.get(read, '__proto__')).toEqual({ polluted: false })
      expect(Reflect.get(read, 'constructor')).toBe('stored')
      expect(Reflect.get({}, 'polluted')).toBeUndefined()
    }),
  ))

test('keeps one global ID namespace and rejects exhausted ID minting', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      yield* storage.commit([entryWrite(EntryId.make(100), rootId)])
      expect(yield* storage.mintId(EntryId)).toBe(EntryId.make(101))
      const owned = yield* Effect.flip(
        storage.commit([{ type: 'task', value: pendingTask(TaskId.make(100), rootId) }]),
      )
      expect(owned.message).toBe('ID 100 already belongs to entry')
      yield* storage.commit([entryWrite(EntryId.make(Number.MAX_SAFE_INTEGER), rootId)])
      expect((yield* Effect.flip(storage.mintId(EntryId))).message).toBe('ID space is exhausted')
    }),
  ))

test('replaces task and submission records and moves them between status indexes', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const rootId = yield* createRoot(storage)
      const task = pendingTask(yield* storage.mintId(TaskId), rootId)
      const queued: SubmissionRecord = {
        id: yield* storage.mintId(SubmissionId),
        conversationId: rootId,
        requestId: 'request',
        type: 'write',
        status: 'queued',
      }
      yield* storage.commit([
        { type: 'task', value: task },
        { type: 'submission', value: queued },
      ])
      const running: TaskRecord = { ...task, state: { status: 'running', checkpoint: {} } }
      const done: SubmissionRecord = { ...queued, status: 'done', entry: EntryId.make(99) }
      yield* storage.commit([
        { type: 'task', value: running },
        { type: 'submission', value: done },
      ])
      expect(ids(yield* storage.scanTasks({ status: 'pending' }, 10))).toEqual([])
      expect(ids(yield* storage.scanTasks({ status: 'running' }, 10))).toEqual([task.id])
      expect(ids(yield* storage.scanTasks({ kind: 'other' }, 10))).toEqual([])
      expect(ids(yield* storage.scanSubmissions({ status: 'done' }, 10))).toEqual([done.id])
      expect(yield* storage.submissionByRequest(rootId, 'request')).toEqual(done)
      expect(yield* storage.submissionByRequest(rootId, 'other')).toBeUndefined()
    }),
  ))

test('fails every operation after its scope closes', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Effect.scoped(make)
      const exit = yield* Effect.exit(storage.conversation(ROOT_CONVERSATION_ID))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* Effect.flip(storage.commit([]))).message).toBe('MemoryStorage is closed')
      expect((yield* Effect.flip(storage.mintId(EntryId))).message).toBe('MemoryStorage is closed')
    }),
  ))

test('builds lazy effects that read the state they run against', () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const read = storage.conversation(ROOT_CONVERSATION_ID)
      const scan = storage.scanConversations({}, 10)
      expect(yield* read).toBeUndefined()
      yield* createRoot(storage)
      expect(yield* read).toEqual({ id: ROOT_CONVERSATION_ID })
      expect(ids(yield* scan)).toEqual([ROOT_CONVERSATION_ID])
    }),
  ))
