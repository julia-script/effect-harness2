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
 */
import { Context, Effect, Layer, Schema } from 'effect'
import type { Duration, Scope } from 'effect'
import { Session } from '../session/Session.ts'
import type { Service as SessionService, Tx } from '../session/Session.ts'
import type { CommitError, TxDocumentError } from '../session/SessionError.ts'
import type { ConversationRecord } from '../storage/schema/Conversation.ts'
import type { ConversationId, SubmissionId } from '../storage/schema/Ids.ts'
import { SubmissionRecord } from '../storage/schema/Submission.ts'
import type { Storage } from '../storage/Storage.ts'
import type { StorageError } from '../storage/StorageError.ts'
import type { Registry } from '../task/Registry.ts'
import { Inspection as SchedulerInspection, Scheduler } from '../task/Scheduler.ts'
import type { Service as SchedulerService } from '../task/Scheduler.ts'
import type { Conversation, CreateOptions, Init } from './Conversation.ts'
import * as internal from './internal/harness.ts'
import type * as Settings from './Settings.ts'
import type { AbortResult, Submission } from './Submission.ts'

/** Live work: scheduling state, every live task, and the queued and placed submissions. */
export const Inspection = Schema.Struct({
  ...SchedulerInspection.fields,
  /** In ID order. */
  submissions: Schema.Array(SubmissionRecord),
})
export type Inspection = typeof Inspection.Type

/** How a Harness runs. */
export interface Options {
  /** Run settings, or an Effect read at every use; absent fields take their defaults. */
  readonly settings?: Settings.Input | Effect.Effect<Settings.Input>
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
 * Open a Harness over the `Storage` and task `Registry` in context: a Session and a Scheduler
 * with the Harness hooks. Closing the scope closes them; pending submission waits fail.
 */
export const makeWith: (
  options: Options,
) => Effect.Effect<Service, CommitError, Storage | Registry | Scope.Scope> = internal.make

/** `makeWith` with the default options. */
export const make: Effect.Effect<Service, CommitError, Storage | Registry | Scope.Scope> = makeWith(
  {},
)

/** A `Harness`, with its `Session` and `Scheduler`, over the provided Storage and Registry. */
export const layerWith = (
  options: Options,
): Layer.Layer<Harness | Session | Scheduler, CommitError, Storage | Registry> =>
  Layer.effectContext(
    Effect.map(makeWith(options), (harness) =>
      Context.make(Harness, harness).pipe(
        Context.add(Session, harness.session),
        Context.add(Scheduler, harness.scheduler),
      ),
    ),
  )

/** `layerWith` with the default options. */
export const layer: Layer.Layer<Harness | Session | Scheduler, CommitError, Storage | Registry> =
  layerWith({})
