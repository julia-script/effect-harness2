import { expect, test } from 'bun:test'
import { Schema } from 'effect'
import {
  ConversationId,
  DocumentRecord,
  EntryRecord,
  StorageWrite,
  SubmissionRecord,
  TaskRecord,
} from './index.ts'

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.decodeUnknownSync(schema)

test('ids are positive integers', () => {
  expect(decode(ConversationId)(1)).toBe(ConversationId.make(1))
  expect(() => decode(ConversationId)(0)).toThrow()
  expect(() => decode(ConversationId)(1.5)).toThrow()
})

test('entries keep pi field names', () => {
  const entry = {
    id: 3,
    conversationId: 1,
    kind: 'pi.user',
    model: [{ role: 'user', content: 'hi', timestamp: 0 }],
    edits: [{ target: 2, action: 'omit' }],
  }
  expect(decode(EntryRecord)(entry) as unknown).toEqual(entry)
})

test('submission status constrains its fields', () => {
  const base = { id: 4, conversationId: 1, type: 'input' }
  expect(decode(SubmissionRecord)({ ...base, status: 'placed', entry: 3 }) as unknown).toEqual({
    ...base,
    status: 'placed',
    entry: 3,
  })
  expect(() => decode(SubmissionRecord)({ ...base, status: 'placed' })).toThrow()
  expect(() =>
    decode(SubmissionRecord)({ ...base, type: 'write', status: 'placed', entry: 3 }),
  ).toThrow()
})

test('settled tasks carry an outcome', () => {
  const task = {
    id: 5,
    conversationId: 1,
    kind: 'run',
    version: 1,
    input: null,
    background: false,
    abortRequested: false,
    state: { status: 'terminal', outcome: { status: 'completed', result: { ok: true } } },
  }
  expect(decode(TaskRecord)(task) as unknown).toEqual(task)
  expect(() =>
    decode(TaskRecord)({ ...task, state: { status: 'terminal', checkpoint: {} } }),
  ).toThrow()
})

test('only conversation documents declare history', () => {
  const record = { id: 6, kind: 'notes', createdAt: 1 }
  const conversation = { kind: 'conversation', conversationId: 1 }
  expect(
    decode(DocumentRecord)({
      ...record,
      scope: conversation,
      history: 'rewindable',
      fork: 'asOf',
    }) as unknown,
  ).toEqual({ ...record, scope: conversation, history: 'rewindable', fork: 'asOf' })
  expect(() =>
    decode(DocumentRecord)({ ...record, scope: conversation, history: 'latest', fork: 'asOf' }),
  ).toThrow()
})

test('document changes carry delta ops', () => {
  const write = {
    type: 'document.change',
    id: 6,
    content: {
      version: 1,
      kind: 'delta',
      ops: [
        ['s', ['title'], 'x'],
        ['a', ['body'], '!'],
      ],
    },
  }
  expect(decode(StorageWrite)(write) as unknown).toEqual(write)
  expect(() =>
    decode(StorageWrite)({ ...write, content: { ...write.content, ops: [['s', [], 'x']] } }),
  ).toThrow()
})
