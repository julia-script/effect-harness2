import { Deferred, Effect, Exit, PubSub, Semaphore } from 'effect'
import type { Scope } from 'effect'
import { Storage } from '../../storage/Storage.ts'
import type { Service as StorageService } from '../../storage/Storage.ts'
import { StorageError } from '../../storage/StorageError.ts'
import type { CommitPublication, Service, SessionEnd, TransactionScope, Tx } from '../Session.ts'
import { SessionClosed, SessionFailed } from '../SessionError.ts'
import { makeTransaction, seal, settle } from './transaction.ts'
import { publication } from './transaction/assemble.ts'
import type { Guarded, Host } from './transaction/state.ts'

/**
 * Session kernel, ported from pi's `session/session.ts`: one mutation line and committed
 * publication. pi's document cache and observation are not ported yet.
 *
 * The line is a one-permit semaphore held for a whole commit, from its callback to its
 * publication. Storage failures are final: the first `StorageError` sets the latch, and every
 * Storage call from then on, also one already underway, fails with `SessionFailed`.
 */
interface Latch {
  failure: StorageError | undefined
  /** Set when the scope starts closing: no more commits are admitted. */
  closing: boolean
  /** Set once admitted commits have settled. */
  closed: boolean
  readonly ended: Deferred.Deferred<SessionEnd>
}

const failed = (cause: StorageError) =>
  new SessionFailed({ message: 'Session failed after a storage error; reopen it', cause })

const healthy = (latch: Latch): Effect.Effect<void, SessionFailed> =>
  latch.failure === undefined ? Effect.void : Effect.fail(failed(latch.failure))

/** Fail the Session with `error`; the first failure wins. */
const fail = (latch: Latch, error: StorageError) =>
  Effect.suspend(() => {
    latch.failure ??= error
    return Effect.andThen(
      Deferred.succeed(latch.ended, { reason: 'failed', error: latch.failure }),
      Effect.fail(failed(latch.failure)),
    )
  })

/** A `StorageRequestError` fails only its call; any other Storage failure fails the Session. */
const guard =
  (latch: Latch): Host['guard'] =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, Guarded<E>> => {
    const isStorageError = (error: E): error is Extract<E, StorageError> =>
      error instanceof StorageError
    return Effect.flatMap(healthy(latch), () =>
      effect.pipe(
        Effect.catchIf(isStorageError, (error) => fail(latch, error)),
        Effect.tap(() => healthy(latch)),
      ),
    )
  }

const runCommit = Effect.fnUntraced(function* <A, E, R>(
  latch: Latch,
  host: Host,
  pubsub: PubSub.PubSub<CommitPublication>,
  change: (tx: Tx) => Effect.Effect<A, E, R>,
  scope: TransactionScope | undefined,
) {
  if (latch.closed) return yield* new SessionClosed({ message: 'Session is closed' })
  yield* healthy(latch)
  const transaction = makeTransaction(host, scope)
  const result = yield* Effect.onExit(change(transaction.tx), (exit) =>
    Exit.isSuccess(exit) ? Effect.void : seal(transaction),
  )
  // A callback that caught a failed read must not commit, nor succeed as if it had.
  yield* healthy(latch)
  const assembly = yield* settle(transaction)
  if (assembly.writes.length === 0) return result
  // Once admitted, interruption waits for Storage to settle and the commit to publish.
  yield* Effect.uninterruptible(
    Effect.flatMap(host.guard(host.storage.commit(assembly.writes)), (seq) =>
      PubSub.publish(pubsub, publication(transaction.state, assembly, seq)),
    ),
  )
  return result
})

export const make: Effect.Effect<Service, never, Storage | Scope.Scope> = Effect.gen(function* () {
  const storage: StorageService = yield* Storage
  const line = yield* Semaphore.make(1)
  const pubsub = yield* PubSub.unbounded<CommitPublication>()
  const latch: Latch = {
    failure: undefined,
    closing: false,
    closed: false,
    ended: yield* Deferred.make<SessionEnd>(),
  }
  const host: Host = { storage, guard: guard(latch) }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      latch.closing = true
      // Admitted commits settle before the Session, and then its Storage, closes.
      yield* Semaphore.withPermit(
        line,
        Effect.sync(() => {
          latch.closed = true
        }),
      )
      yield* Deferred.succeed(latch.ended, { reason: 'closed' })
      yield* PubSub.shutdown(pubsub)
    }),
  )
  const service: Service = {
    commit: (change, scope) =>
      Effect.suspend(() =>
        latch.closing
          ? Effect.fail(new SessionClosed({ message: 'Session is closed' }))
          : Semaphore.withPermit(line, runCommit(latch, host, pubsub, change, scope)),
      ),
    subscribe: PubSub.subscribe(pubsub),
    ended: Deferred.await(latch.ended),
  }
  return service
})
