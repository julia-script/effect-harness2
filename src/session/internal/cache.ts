import { Clock, Effect, Fiber, Semaphore } from 'effect'
import type { Scope } from 'effect'
import * as Tracker from '../../delta/Tracker.ts'
import type { Service as Storage } from '../../storage/Storage.ts'
import type { StorageRequestError } from '../../storage/StorageError.ts'
import type { DocumentAddress, DocumentRecord } from '../../storage/schema/Document.ts'
import type { JsonObject } from '../../storage/schema/Json.ts'
import type { AnyDefinition } from './documents.ts'
import { materialize, refused } from './documents.ts'
import type { DocumentError, SessionFailed } from '../SessionError.ts'
import type { Guarded } from './transaction/state.ts'

/**
 * The Session's cache of loaded document trackers, ported from pi's `session/session.ts`.
 *
 * Every cached incarnation is idle until observation lands, and an idle one leaves the cache once
 * it was not used for the retention. Eviction runs on the mutation line, so no transaction ever
 * holds a tracker that leaves: a sweep fiber sleeps until the oldest idle document expires, and
 * every commit sweeps when it ends.
 */

/** One committed document incarnation and its tracker. */
export interface Loaded {
  readonly addressId: string
  readonly record: DocumentRecord
  /** Persisted definition version; older while the value is migrated only in memory. */
  storedVersion: number
  /** Definition version whose shape the tracked value has; another version reloads. */
  readonly valueVersion: number
  /** Stored deltas after the newest base, advanced by adoption. */
  deltasSinceBase: number
  readonly tracker: Tracker.Tracker<JsonObject>
}

export interface Cache {
  /** The cached incarnation at an address, without loading; a hit counts as a use. */
  readonly cached: (addressId: string) => Effect.Effect<Loaded | undefined>
  /** The cached incarnation for a definition's version, loading and migrating it on a miss. */
  readonly load: (
    definition: AnyDefinition,
    addressId: string,
    address: DocumentAddress,
  ) => Effect.Effect<Loaded | undefined, DocumentError | SessionFailed | StorageRequestError>
  /** Cache a newly committed incarnation. */
  readonly install: (loaded: Loaded) => Effect.Effect<void>
  /** Drop a retired incarnation if it is still the one cached at its address. */
  readonly evict: (addressId: string, recordId: DocumentRecord['id']) => Effect.Effect<void>
  /** Note a use of a cached document. */
  readonly touch: (addressId: string) => Effect.Effect<void>
  /** On the line: evict every idle document whose retention passed. */
  readonly sweep: Effect.Effect<void>
  /** Drop every tracker; later access loads from Storage. */
  readonly clear: Effect.Effect<void>
}

interface State {
  readonly documents: Map<string, Loaded>
  /** Idle documents by address, oldest use first, with the time of that use. */
  readonly idle: Map<string, number>
  /** The pending eviction of the oldest idle document. */
  pending: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined
}

interface Environment {
  readonly storage: Storage
  /** Run a Storage call behind the Session's failure latch. */
  readonly guard: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, Guarded<E>>
  readonly retention: number
  readonly line: Semaphore.Semaphore
  readonly scope: Scope.Scope
}

const loadDocument = Effect.fnUntraced(function* (
  cache: Cache,
  state: State,
  { guard, storage }: Environment,
  definition: AnyDefinition,
  addressId: string,
  address: DocumentAddress,
): Effect.fn.Return<Loaded | undefined, DocumentError | SessionFailed | StorageRequestError> {
  const cached = state.documents.get(addressId)
  // A tracker serves only definitions of the version its value has; others reload.
  if (cached?.valueVersion === definition.version) {
    yield* cache.touch(addressId)
    return cached
  }
  if (cached !== undefined) drop(state, addressId)
  const record = yield* guard(storage.findDocument(address, 'current'))
  if (record === undefined) return undefined
  const stored = yield* guard(storage.document(record.id, 'current'))
  if (stored === undefined) {
    return yield* refused(`Current document ${record.id} (${record.kind}) cannot be read`)
  }
  const value = yield* materialize(definition, stored)
  const loaded: Loaded = {
    addressId,
    record: stored.record,
    storedVersion: stored.version,
    valueVersion: definition.version,
    deltasSinceBase: stored.deltasSinceBase,
    tracker: yield* Tracker.make(value),
  }
  state.documents.set(addressId, loaded)
  yield* cache.touch(addressId)
  return loaded
})

const drop = (state: State, addressId: string) => {
  state.documents.delete(addressId)
  state.idle.delete(addressId)
}

/** Schedule the eviction of the oldest idle document, replacing a later pending one. */
const schedule = (state: State, environment: Environment, sweep: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const oldest = state.idle.values().next()
    if (oldest.done === true) return
    const at = oldest.value + environment.retention
    if (!Number.isFinite(at)) return
    const pending = state.pending
    if (pending !== undefined && pending.at <= at) return
    if (pending !== undefined) yield* Fiber.interrupt(pending.fiber)
    const delay = Math.max(0, at - (yield* Clock.currentTimeMillis))
    const job = Effect.andThen(
      Effect.sleep(delay),
      Semaphore.withPermit(
        environment.line,
        Effect.suspend(() => {
          // Cleared first, so the sweep's own scheduling never interrupts this fiber.
          if (state.pending?.at === at) state.pending = undefined
          return sweep
        }),
      ),
    )
    state.pending = { at, fiber: yield* Effect.forkIn(job, environment.scope) }
  })

/** Evict every idle document whose retention passed, oldest first, then schedule the next. */
const makeSweep = (state: State, environment: Environment) => {
  const sweep: Effect.Effect<void> = Effect.gen(function* () {
    const expired = (yield* Clock.currentTimeMillis) - environment.retention
    for (const [addressId, since] of state.idle) {
      if (since > expired) break
      drop(state, addressId)
    }
    yield* schedule(state, environment, sweep)
  })
  return sweep
}

/** Note a use: the document becomes the newest idle one, and its eviction is scheduled. */
const makeTouch = (state: State, environment: Environment, sweep: Effect.Effect<void>) => {
  const { retention } = environment
  // A hot document moves to the back at most once per granule: a tenth of the retention, up to a
  // second. It may leave up to a granule early, which costs a reload.
  const granule = Math.min(1000, retention / 10)
  return (addressId: string) =>
    Effect.gen(function* () {
      if (!state.documents.has(addressId)) return
      const now = yield* Clock.currentTimeMillis
      const since = state.idle.get(addressId)
      if (since !== undefined && now - since < granule) return
      state.idle.delete(addressId)
      state.idle.set(addressId, now)
      if (state.pending === undefined || state.pending.at > now + retention) {
        yield* schedule(state, environment, sweep)
      }
    })
}

export const make = (environment: Environment): Cache => {
  const state: State = { documents: new Map(), idle: new Map(), pending: undefined }
  const sweep = makeSweep(state, environment)
  const touch = makeTouch(state, environment, sweep)
  const cache: Cache = {
    cached: (addressId) =>
      Effect.suspend(() => {
        const cached = state.documents.get(addressId)
        return cached === undefined ? Effect.undefined : Effect.as(touch(addressId), cached)
      }),
    load: (definition, addressId, address) =>
      loadDocument(cache, state, environment, definition, addressId, address),
    install: (loaded) =>
      Effect.suspend(() => {
        state.documents.set(loaded.addressId, loaded)
        return touch(loaded.addressId)
      }),
    evict: (addressId, recordId) =>
      Effect.sync(() => {
        if (state.documents.get(addressId)?.record.id === recordId) drop(state, addressId)
      }),
    touch,
    sweep,
    clear: Effect.sync(() => {
      state.documents.clear()
      state.idle.clear()
    }),
  }
  return cache
}
