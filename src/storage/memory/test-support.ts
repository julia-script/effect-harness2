import { Effect } from 'effect'
import { layer } from '../memory.ts'
import { ConversationId, EntryId, ROOT_CONVERSATION_ID } from '../schema/index.ts'
import type { EntryRecord, StorageWrite, TaskId, TaskRecord } from '../schema/index.ts'
import { Storage } from '../Storage.ts'
import type { StorageService } from '../Storage.ts'

/** Run a test body against a fresh memory store. */
export const withStorage = <A, E>(
  body: (storage: StorageService) => Effect.Effect<A, E>,
): Promise<A> =>
  // Each test is an entry point that provides its own store.
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  Effect.runPromise(Storage.use(body).pipe(Effect.provide(layer)))

export const createRoot = (storage: StorageService) =>
  storage
    .commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }])
    .pipe(Effect.as(ROOT_CONVERSATION_ID))

export const entry = (
  id: EntryId,
  conversationId: ConversationId,
  kind = 'message',
  extra: Partial<EntryRecord> = {},
): EntryRecord => ({ id, conversationId, kind, ...extra })

export const entryWrite = (...args: Parameters<typeof entry>): StorageWrite => ({
  type: 'entry',
  value: entry(...args),
})

export const pendingTask = (id: TaskId, conversationId: ConversationId, phase = 'ready') =>
  ({
    id,
    conversationId,
    kind: 'test.task',
    version: 1,
    input: { value: id },
    state: { status: 'pending', checkpoint: { phase } },
    background: false,
    abortRequested: false,
  }) satisfies TaskRecord

export const ids = (page: { readonly items: ReadonlyArray<{ readonly id: number }> }) =>
  page.items.map(({ id }) => id)

export const conversationId = (value: number) => ConversationId.make(value)
export const entryId = (value: number) => EntryId.make(value)
