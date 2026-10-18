/**
 * The `Harness` service, ported from pi's `harness/harness.ts`: conversations, the admission of
 * submissions, the `pi.inbox` boundaries, and run control in `pi.live`, over one Session and its
 * task Scheduler.
 *
 * Every conversation gets the built-in documents in the commit that creates or forks it. Input to
 * an idle conversation starts a run: a `pi.generation` task that holds `pi.live.run` until it
 * settles the run's inputs. While the run is live, submissions queue in `pi.inbox`, and the run
 * places them at its boundaries. Aborting a conversation, or a cascade that reaches one, withdraws
 * its queued inputs; a run task the scheduler faults or orphans ends its run `unanswered`.
 *
 * This is the loop side, for code that runs with the loop, such as tasks. Calling code uses
 * `HarnessClient` instead, which reaches the loop through `HarnessServer` over a transport.
 */
import { Context, Effect, Layer } from 'effect'
import type { Duration, Scope } from 'effect'
import * as Rpcs from '../client/HarnessRpcs.ts'
import { Session } from '../session/Session.ts'
import type { Service as SessionService, Tx } from '../session/Session.ts'
import type { CommitError, TxDocumentError } from '../session/SessionError.ts'
import type { ConversationRecord } from '../storage/schema/Conversation.ts'
import type { ConversationId, SubmissionId } from '../storage/schema/Ids.ts'
import type { Storage } from '../storage/Storage.ts'
import type { StorageError } from '../storage/StorageError.ts'
import type { Registry } from '../task/Registry.ts'
import { Scheduler } from '../task/Scheduler.ts'
import type { Service as SchedulerService } from '../task/Scheduler.ts'
import type { Conversation, CreateOptions, Init } from './Conversation.ts'
import type { Extensions } from './Extensions.ts'
import * as internal from './internal/harness.ts'
import type { AbortResult, Submission } from './Submission.ts'

/** Live work: scheduling state, every live task, and the queued and placed submissions. */
export const Inspection = Rpcs.Inspection
export type Inspection = Rpcs.Inspection

/** How a Harness runs. */
export interface Options {
  /**
   * Runs in every commit that creates or forks a conversation, raw `tx.createConversation()`
   * included, after the built-in documents and before `init`.
   */
  readonly conversationCreated?: (
    tx: Tx,
    record: ConversationRecord,
  ) => Effect.Effect<void, TxDocumentError>
  /** The Session's document retention. */
  readonly documentRetention?: Duration.Input
}

export interface Service {
  /** The Session the Harness owns. */
  readonly session: SessionService
  /** The task Scheduler the Harness owns. */
  readonly scheduler: SchedulerService
  /** The reserved root conversation, created with `init` in one commit when absent. */
  readonly root: <E = never>(options?: {
    readonly init?: Init<E>
  }) => Effect.Effect<Conversation, E | CommitError>
  readonly conversation: (
    id: ConversationId,
  ) => Effect.Effect<Conversation | undefined, CommitError>
  readonly createConversation: <E = never>(
    options: CreateOptions<E>,
  ) => Effect.Effect<Conversation, E | CommitError>
  /** Reacquire a submission, for example after reopening. */
  readonly submission: (id: SubmissionId) => Effect.Effect<Submission | undefined, CommitError>
  /**
   * Withdraw a queued submission. `not_found` for an unknown submission, or one of another
   * conversation than `conversationId`.
   */
  readonly abortSubmission: (
    id: SubmissionId,
    conversationId?: ConversationId,
  ) => Effect.Effect<AbortResult | 'not_found', CommitError>
  /** Live tasks and unsettled submissions. Writes nothing and runs no task code. */
  readonly inspect: Effect.Effect<Inspection, CommitError | StorageError>
}

export class Harness extends Context.Service<Harness, Service>()(
  'effect-harness/harness/Harness',
) {}

/**
 * Open a Harness over the `Storage`, task `Registry` and `Extensions` in context: a Session and a Scheduler
 * with the Harness hooks. Run settings come from `Settings.Current`. Closing the scope closes them; pending submission waits fail.
 */
export const makeWith: (
  options: Options,
) => Effect.Effect<Service, CommitError, Storage | Registry | Extensions | Scope.Scope> =
  internal.make

/** `makeWith` with the default options. */
export const make: Effect.Effect<
  Service,
  CommitError,
  Storage | Registry | Extensions | Scope.Scope
> = makeWith({})

/** A `Harness`, with its `Session` and `Scheduler`, over the provided Storage and Registry. */
export const layerWith = (
  options: Options,
): Layer.Layer<Harness | Session | Scheduler, CommitError, Storage | Registry | Extensions> =>
  Layer.effectContext(
    Effect.map(makeWith(options), (harness) =>
      Context.make(Harness, harness).pipe(
        Context.add(Session, harness.session),
        Context.add(Scheduler, harness.scheduler),
      ),
    ),
  )

/** `layerWith` with the default options. */
export const layer: Layer.Layer<
  Harness | Session | Scheduler,
  CommitError,
  Storage | Registry | Extensions
> = layerWith({})
