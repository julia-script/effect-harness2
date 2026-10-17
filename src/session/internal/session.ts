import { Deferred, Effect, Exit, Option, PubSub, Semaphore } from 'effect'
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
 * publication. Lifecycle is three one-shot `Deferred`s. Storage failures are final: the first
 * `StorageError` completes `failure`, and every Storage call from then on, also one already
 * underway, fails with `SessionFailed`. `closing` completes when the scope starts closing and
 * admits no more commits; `ended` completes once, with whichever end came first.
 *
 * Effect's `Latch` is a gate that suspends its waiters while closed, so it fits neither: a failed
 * or closing Session must fail callers at once, not hold them.
 */
interface Lifecycle {
  readonly failure: Deferred.Deferred<never, SessionFailed>
  readonly closing: Deferred.Deferred<void>
  readonly ended: Deferred.Deferred<SessionEnd>
}

const failed = (cause: StorageError) =>
  new SessionFailed({ message: 'Session failed after a storage error; reopen it', cause })

const healthy = (lifecycle: Lifecycle): Effect.Effect<void, SessionFailed> =>
  Effect.flatMap(
    Deferred.poll(lifecycle.failure),
    Option.getOrElse(() => Effect.void),
  )

/** Fail the Session with `error`; the first failure wins. */
const fail = (lifecycle: Lifecycle, error: StorageError) =>
  Effect.andThen(
    Effect.all([
      Deferred.fail(lifecycle.failure, failed(error)),
      Deferred.succeed(lifecycle.ended, { reason: 'failed', error }),
    ]),
    Deferred.await(lifecycle.failure),
  )

/** A `StorageRequestError` fails only its call; any other Storage failure fails the Session. */
const guard =
  (lifecycle: Lifecycle): Host['guard'] =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, Guarded<E>> => {
    const isStorageError = (error: E): error is Extract<E, StorageError> =>
      error instanceof StorageError
    return Effect.flatMap(healthy(lifecycle), () =>
      effect.pipe(
        Effect.catchIf(isStorageError, (error) => fail(lifecycle, error)),
        Effect.tap(() => healthy(lifecycle)),
      ),
    )
  }

const runCommit = Effect.fnUntraced(function* <A, E, R>(
  lifecycle: Lifecycle,
  host: Host,
  pubsub: PubSub.PubSub<CommitPublication>,
  change: (tx: Tx) => Effect.Effect<A, E, R>,
  scope: TransactionScope | undefined,
) {
  yield* healthy(lifecycle)
  // A healthy Session has ended only by closing: this commit queued behind the finalizer.
  if (yield* Deferred.isDone(lifecycle.ended)) {
    return yield* new SessionClosed({ message: 'Session is closed' })
  }
  const transaction = makeTransaction(host, scope)
  const result = yield* Effect.onExit(change(transaction.tx), (exit) =>
    Exit.isSuccess(exit) ? Effect.void : seal(transaction),
  )
  // A callback that caught a failed read must not commit, nor succeed as if it had.
  yield* healthy(lifecycle)
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
  const lifecycle: Lifecycle = {
    failure: yield* Deferred.make<never, SessionFailed>(),
    closing: yield* Deferred.make<void>(),
    ended: yield* Deferred.make<SessionEnd>(),
  }
  const host: Host = { storage, guard: guard(lifecycle) }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.done(lifecycle.closing, Exit.void)
      // Admitted commits settle before the Session, and then its Storage, closes.
      yield* Semaphore.withPermit(line, Deferred.succeed(lifecycle.ended, { reason: 'closed' }))
      yield* PubSub.shutdown(pubsub)
    }),
  )
  const service: Service = {
    commit: (change, scope) =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(lifecycle.closing)
          ? Effect.fail(new SessionClosed({ message: 'Session is closed' }))
          : Semaphore.withPermit(line, runCommit(lifecycle, host, pubsub, change, scope)),
      ),
    subscribe: PubSub.subscribe(pubsub),
    ended: Deferred.await(lifecycle.ended),
  }
  return service
})
