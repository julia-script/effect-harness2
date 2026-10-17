import { Effect } from 'effect'
import type { Scope } from 'effect'
import type { JsonObject } from '../../storage/schema/Json.ts'
import type { SnapshotError } from '../Session.ts'
import type { Cache, Loaded } from './cache.ts'
import { checkRecordScope, checkRecordVersion, resolveAddress } from './documents.ts'
import type { AnyToken } from './documents.ts'
import type { Attached, Observer, Observers } from './observers.ts'
import type { OnLine } from './snapshots.ts'

/** Build an observation of a committed value, of a definition version, with its release. */
export type Create<O> = (
  value: Readonly<JsonObject>,
  version: number,
  release: Effect.Effect<void>,
) => Effect.Effect<Attached<O>>

/** Attach an observation to a loaded incarnation until its scope closes or it retires. */
const attach = <O>(
  cache: Cache,
  observers: Observers,
  loaded: Loaded,
  create: Create<O>,
): Effect.Effect<O, never, Scope.Scope> =>
  Effect.gen(function* () {
    const value = yield* loaded.tracker.value
    const recordId = loaded.record.id
    const acquire = Effect.gen(function* () {
      const unpin = yield* cache.pin(loaded.addressId, recordId)
      let observer: Observer | undefined
      let released = false
      const release = Effect.suspend(() => {
        if (released || observer === undefined) return Effect.void
        released = true
        return Effect.andThen(observers.detach(recordId, observer), unpin)
      })
      const attached = yield* create(value, loaded.valueVersion, release)
      observer = attached.observer
      yield* observers.attach(recordId, observer)
      return { attached, release }
    })
    const { attached } = yield* Effect.acquireRelease(acquire, ({ attached: { close }, release }) =>
      Effect.andThen(release, close),
    )
    return attached.observation
  })

/**
 * Attach an observation to the current incarnation at a token's address, on the mutation line,
 * so that no commit lands between its baseline and its attachment. The incarnation stays pinned
 * in the cache until the observation's scope closes or the incarnation retires.
 */
export const observe = <O>(
  cache: Cache,
  observers: Observers,
  onLine: OnLine,
  token: AnyToken,
  args: ReadonlyArray<unknown>,
  create: Create<O>,
): Effect.Effect<O | undefined, SnapshotError, Scope.Scope> =>
  onLine(
    Effect.gen(function* (): Effect.fn.Return<O | undefined, SnapshotError, Scope.Scope> {
      const definition = token.definition
      const { address, id } = yield* resolveAddress(definition, args)
      const loaded = yield* cache.load(definition, id, address)
      if (loaded === undefined) return undefined
      yield* checkRecordScope(definition, loaded.record)
      yield* checkRecordVersion(definition, loaded.record, loaded.storedVersion)
      return yield* attach(cache, observers, loaded, create)
    }),
  )
