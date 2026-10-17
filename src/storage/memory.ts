import { Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import { commit } from './memory/commit.ts'
import { materializeDocument } from './memory/documents.ts'
import * as Reads from './memory/reads.ts'
import { addressKey, assertOpen as open, isAliveAt, makeState } from './memory/state.ts'
import type { State } from './memory/state.ts'
import { StorageRequestError } from './schema/index.ts'
import type { DocumentAddress, DocumentPoint, DocumentRecord } from './schema/index.ts'
import { Storage } from './Storage.ts'
import type { IdSchema, StorageId, StorageService } from './Storage.ts'
import { StorageError } from './StorageError.ts'

/**
 * Detached in-memory reference implementation of `Storage`, ported from pi's
 * `packages/durable/src/storage/memory.ts`.
 *
 * Reads and retained writes are cloned to match the ownership boundary of serialization-backed
 * stores. This is backend conformance, not validation: records are trusted to match their schema.
 */

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

const toStorageError = (cause: unknown): StorageError =>
  cause instanceof StorageError ? cause : new StorageError({ message: errorMessage(cause), cause })

/** Run a read whose invalid requests fail only that read; anything else is fatal. */
const read = <A>(f: () => A): Effect.Effect<A, StorageRequestError | StorageError> =>
  Effect.try({
    try: f,
    catch: (cause) => (cause instanceof StorageRequestError ? cause : toStorageError(cause)),
  })

/** Run an operation whose every failure is fatal, request errors included. */
const fatal = <A>(f: () => A): Effect.Effect<A, StorageError> =>
  Effect.try({ try: f, catch: toStorageError })

const mint = <I extends StorageId>(state: State, id: IdSchema<I>): I => {
  if (!Number.isSafeInteger(open(state).nextId)) throw new Error('ID space is exhausted')
  const value = id.make(state.nextId)
  state.nextId++
  return value
}

const findDocument = (
  state: State,
  address: DocumentAddress,
  at: DocumentPoint,
): DocumentRecord | undefined => {
  const index = state.documentAddresses.get(addressKey(address))
  const id =
    at === 'current'
      ? index?.currentId
      : index?.ids.find((candidate) => {
          const record = state.documents.get(candidate)?.record
          return record !== undefined && isAliveAt(record, at)
        })
  return id === undefined ? undefined : structuredClone(state.documents.get(id)?.record)
}

const service = (state: State): StorageService => ({
  commit: (writes) => fatal(() => commit(state, writes)),
  mintId: (id) => fatal(() => mint(state, id)),
  conversation: (id) => fatal(() => structuredClone(open(state).conversations.get(id))),
  scanConversations: (query, limit, cursor) =>
    read(() => Reads.scanConversations(open(state), query, limit, cursor)),
  entry: (id) => fatal(() => Reads.storedEntry(open(state), id)),
  visibleEntry: (conversationId, id) =>
    read(() => Reads.visibleEntry(open(state), conversationId, id)),
  findLatestHeadMarker: (conversationId, atOrBefore) =>
    read(() => Reads.findLatestHeadMarker(open(state), conversationId, atOrBefore)),
  scanEntries: (query, limit, cursor) =>
    read(() => Reads.scanEntries(open(state), query, limit, cursor)),
  task: (id) => fatal(() => structuredClone(open(state).tasks.get(id))),
  scanTasks: (query, limit, cursor) =>
    read(() => Reads.scanTasks(open(state), query, limit, cursor)),
  submission: (id) => fatal(() => structuredClone(open(state).submissions.get(id))),
  scanSubmissions: (query, limit, cursor) =>
    read(() => Reads.scanSubmissions(open(state), query, limit, cursor)),
  submissionByRequest: (conversationId, requestId) =>
    fatal(() => {
      const id = open(state).submissionIdsByRequest.get(conversationId)?.get(requestId)
      return id === undefined ? undefined : structuredClone(state.submissions.get(id))
    }),
  findDocument: (address, at) => fatal(() => findDocument(open(state), address, at)),
  // `materializeDocument` already detached the value; only the record needs a copy.
  document: (id, at) =>
    read(() => {
      const stored = materializeDocument(open(state), id, at)
      return stored === undefined
        ? undefined
        : { ...stored, record: structuredClone(stored.record) }
    }),
  scanDocuments: (query, limit, cursor) =>
    read(() => Reads.scanDocuments(open(state), query, limit, cursor)),
})

/**
 * Build an empty in-memory store. Closing the scope closes the store: every later operation fails
 * with a `StorageError`.
 */
export const make: Effect.Effect<StorageService, never, Scope.Scope> = Effect.gen(function* () {
  const state = makeState()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state.closed = true
    }),
  )
  return service(state)
})

/** A fresh, empty in-memory `Storage` for each build of the layer. */
export const layer: Layer.Layer<Storage> = Layer.effect(Storage, make)
