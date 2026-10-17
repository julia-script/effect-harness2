import { Effect } from 'effect'
import { Storage } from '../../index.ts'
import { Entry, Ids, Task, Write } from '../../schema/index.ts'

/** Run a test body against a fresh memory store. */
export const withStorage = <A, E>(
  body: (storage: Storage.Service) => Effect.Effect<A, E>,
): Promise<A> =>
  // Each test is an entry point that provides its own store.
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  Effect.runPromise(Storage.Storage.use(body).pipe(Effect.provide(Storage.layerMemory)))

export const createRoot = (storage: Storage.Service) =>
  storage
    .commit([{ type: 'conversation', value: { id: Ids.ROOT_CONVERSATION_ID } }])
    .pipe(Effect.as(Ids.ROOT_CONVERSATION_ID))

export const entry = (
  id: Ids.EntryId,
  conversationId: Ids.ConversationId,
  kind = 'message',
  extra: Partial<Entry.EntryRecord> = {},
): Entry.EntryRecord => ({ id, conversationId, kind, ...extra })

export const entryWrite = (...args: Parameters<typeof entry>): Write.StorageWrite => ({
  type: 'entry',
  value: entry(...args),
})

export const pendingTask = (id: Ids.TaskId, conversationId: Ids.ConversationId, phase = 'ready') =>
  ({
    id,
    conversationId,
    kind: 'test.task',
    version: 1,
    input: { value: id },
    state: { status: 'pending', checkpoint: { phase } },
    background: false,
    abortRequested: false,
  }) satisfies Task.TaskRecord

export const ids = (page: { readonly items: ReadonlyArray<{ readonly id: number }> }) =>
  page.items.map(({ id }) => id)

export const conversationId = (value: number) => Ids.ConversationId.make(value)
export const entryId = (value: number) => Ids.EntryId.make(value)
