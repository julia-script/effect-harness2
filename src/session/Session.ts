/**
 * The `Session` service: one mutation line over a `Storage`, its transactions, and the
 * publication of what each commit changed. Ported from pi's `packages/durable/src/session`.
 */
import { Context, Layer } from 'effect'
import type { Effect, PubSub, Schema, Scope } from 'effect'
import type { Storage } from '../storage/Storage.ts'
import type { StorageError, StorageRequestError } from '../storage/StorageError.ts'
import type { ConversationRecord } from '../storage/schema/Conversation.ts'
import type { DocumentCopySource, DocumentRecord, Op } from '../storage/schema/Document.ts'
import type { EntryRecord } from '../storage/schema/Entry.ts'
import type { ConversationId, EntryId, Seq, SubmissionId, TaskId } from '../storage/schema/Ids.ts'
import type {
  ConversationQuery,
  Cursor,
  EntryQuery,
  Page,
  TaskQuery,
} from '../storage/schema/Scan.ts'
import type { SubmissionCreate, SubmissionRecord } from '../storage/schema/Submission.ts'
import type { TaskRecord } from '../storage/schema/Task.ts'
import type { StorageWrite } from '../storage/schema/Write.ts'
import * as internal from './internal/session.ts'
import type {
  ReadAfterWrite,
  SessionClosed,
  SessionFailed,
  TransactionError,
} from './SessionError.ts'

/** Ownership selected explicitly whenever a conversation is created. */
export type ConversationOwnership =
  | { readonly kind: 'ownerless' }
  | { readonly kind: 'task'; readonly taskId: TaskId }

/** Who owns a task: its conversation, or another task of the same conversation. */
export type TaskOwnership =
  | { readonly kind: 'conversation' }
  | { readonly kind: 'task'; readonly taskId: TaskId }

/** Creation options for a durable task. */
export interface TaskOptions {
  /** Required: a task always names its owner. */
  readonly ownership: TaskOwnership
  /**
   * Default: the owner task's conversation, or the transaction's bound conversation; required
   * for conversation-owned tasks created by commits that are not bound to a conversation.
   */
  readonly conversationId?: ConversationId
  /** Conversation-owned tasks only: excluded from idle waits, conversation aborts, and cascades. */
  readonly background?: boolean
  /** Its creator awaits it only in memory, so a later Harness abort-marks it with `restart`. */
  readonly abandonOnRestart?: boolean
}

/**
 * What `Tx.createTask()` needs of a task definition: its persisted kind and version, and the
 * checkpoint a new task starts from. The task runtime's definitions satisfy it.
 */
export interface TaskKind<I extends Schema.Json> {
  /** Registered task definition name, stored as the record's `kind`. */
  readonly name: string
  /** Positive integer version of the stored input and checkpoint shapes. */
  readonly version: number
  readonly initial: (input: I) => Schema.Json
}

/** Entry content supplied before the Session assigns identity and task attribution. */
export type EntryDraft = Omit<EntryRecord, 'id' | 'conversationId' | 'byTaskId' | 'head'> & {
  /** `'self'` starts active context at the newly assigned entry ID. */
  readonly head?: EntryId | 'self'
}

/** Terminal status staged for a submission; identity, type, and entry come from its record. */
export type SubmissionSettlement =
  | { readonly status: 'done'; readonly answer: EntryId }
  | { readonly status: 'unanswered'; readonly reason: string; readonly detail?: Schema.Json }

/** Defaults a commit binds to, as the task runtime's own commits do. */
export interface TransactionScope {
  /** Default `Tx.createTask()` conversation. */
  readonly conversationId?: ConversationId
  /** Task whose runtime commit this is; stamped as `byTaskId` on appended entries. */
  readonly taskId?: TaskId
}

/** Committed change of one document incarnation. */
export type DocumentCommitChange =
  | {
      readonly type: 'document'
      readonly record: DocumentRecord
      /** Conversation owning the document; task documents take their task's. */
      readonly conversationId: ConversationId | undefined
      /** Definition version of `value`; absent when this commit retired the incarnation. */
      readonly version: number | undefined
      /** Adopted revision, or `null` when this commit retired the incarnation. */
      readonly value: Schema.JsonObject | null
      /** Adopted operations of an ordinary update; empty for creation and retirement. */
      readonly ops: ReadonlyArray<Op>
    }
  | {
      /** Definition-free child initialization of a fork. */
      readonly type: 'document.copy'
      readonly record: DocumentRecord
      readonly conversationId: ConversationId
      readonly source: DocumentCopySource
    }

/** A complete table record, published as the write that committed it. */
export type TableCommitChange = Extract<
  StorageWrite,
  { readonly type: 'conversation' | 'entry' | 'task' | 'submission' }
>

export type CommitChange = TableCommitChange | DocumentCommitChange

/** Every change of one successful commit. Change order is unspecified. */
export interface CommitPublication {
  readonly seq: Seq
  readonly changes: ReadonlyArray<CommitChange>
}

/** Why a Session ended: its scope closed, or Storage failed it with `error`. */
export type SessionEnd =
  | { readonly reason: 'closed' }
  | { readonly reason: 'failed'; readonly error: StorageError }

/** How a `Tx` operation fails: a rejected operation, or a failed Session. */
export type TxError = TransactionError | SessionFailed

/** How a `Tx` table read fails. */
export type TxReadError = TxError | ReadAfterWrite | StorageRequestError

/** How a commit fails besides its callback's own errors. */
export type CommitError = TxError | SessionClosed | StorageRequestError

/**
 * The transaction of one commit callback. Reads see committed state only, and only before the
 * transaction's first table write (`ReadAfterWrite`). Records it returns are immutable and are
 * shared with commit subscribers. Every operation fails once the callback has ended.
 */
export interface Tx {
  readonly conversation: (
    id: ConversationId,
  ) => Effect.Effect<ConversationRecord | undefined, TxReadError>
  readonly entry: (id: EntryId) => Effect.Effect<EntryRecord | undefined, TxReadError>
  readonly task: (id: TaskId) => Effect.Effect<TaskRecord | undefined, TxReadError>
  readonly submission: (
    id: SubmissionId,
  ) => Effect.Effect<SubmissionRecord | undefined, TxReadError>
  /** Committed submission with a conversation-scoped request ID. */
  readonly submissionByRequest: (
    conversationId: ConversationId,
    requestId: string,
  ) => Effect.Effect<SubmissionRecord | undefined, TxReadError>
  readonly scanConversations: (
    query: ConversationQuery,
    limit: number,
    cursor?: Cursor,
  ) => Effect.Effect<Page<ConversationRecord>, TxReadError>
  readonly scanEntries: (
    query: EntryQuery,
    limit: number,
    cursor?: Cursor,
  ) => Effect.Effect<Page<EntryRecord>, TxReadError>
  readonly scanTasks: (
    query: TaskQuery,
    limit: number,
    cursor?: Cursor,
  ) => Effect.Effect<Page<TaskRecord>, TxReadError>
  /** Newest visible entry of the conversation that carries a `head`. */
  readonly latestHeadMarker: (
    conversationId: ConversationId,
  ) => Effect.Effect<(EntryRecord & { readonly head: EntryId }) | undefined, TxReadError>

  /** Create a conversation with explicitly selected ownership. */
  readonly createConversation: (options: {
    readonly ownership: ConversationOwnership
  }) => Effect.Effect<ConversationRecord, TxError | StorageRequestError>
  /** Create the root conversation at its reserved ID, as a Harness does once. */
  readonly createRootConversation: Effect.Effect<ConversationRecord, TxError | StorageRequestError>
  /**
   * Fork history at one visible entry of `parentConversationId`. The fork copies the parent's
   * conversation documents: `asOf` ones as of the entry's commit, `current` ones as they are now.
   */
  readonly forkConversation: (
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ) => Effect.Effect<ConversationRecord, TxError | StorageRequestError>
  readonly appendEntry: (
    conversationId: ConversationId,
    draft: EntryDraft,
  ) => Effect.Effect<EntryRecord, TxError>
  readonly createTask: <I extends Schema.Json>(
    kind: TaskKind<I>,
    input: I,
    options: TaskOptions,
  ) => Effect.Effect<TaskId, TxError>
  /** Create a raw submission with a fresh ID. No admission rules apply. */
  readonly createSubmission: (create: SubmissionCreate) => Effect.Effect<SubmissionRecord, TxError>
  /**
   * Settle a queued or placed submission; only a placed input can be answered, and a settled
   * submission stays unchanged. Resolved at the end of the callback against this transaction's
   * latest record of it, so it is not a read and works after table writes.
   */
  readonly settleSubmission: (
    id: SubmissionId,
    settlement: SubmissionSettlement,
  ) => Effect.Effect<void, TxError>
  /** Place a queued submission at `entry`: an input becomes `placed`, a write `done`. */
  readonly placeSubmission: (id: SubmissionId, entry: EntryId) => Effect.Effect<void, TxError>
  /**
   * Replace one task record completely, as the task runtime does. Stamps `startedAt` on the first
   * change to `running` and `endedAt` on the change to `terminal`; a terminal task's documents
   * retire in the same commit.
   */
  readonly setTask: (record: TaskRecord) => Effect.Effect<TaskRecord, TxError>
}

/**
 * Owner of one mutation line over a `Storage`.
 *
 * Commits are serialized: each runs its callback, validates the staged batch, persists it in one
 * `Storage.commit`, and publishes it, while it holds the line. Inside a callback read only through
 * `tx`; a nested `commit` would wait for the line the callback holds.
 *
 * The first `StorageError` fails the Session: that call and every later one fail with
 * `SessionFailed`. A `StorageRequestError` fails only the read that asked for it. Closing the
 * Session's scope lets admitted commits finish and refuses new ones with `SessionClosed`.
 */
export interface Service {
  /**
   * Run one atomic transaction. When the callback fails or is interrupted nothing is committed;
   * once the batch reaches Storage, interruption waits for it to settle.
   */
  readonly commit: <A, E, R>(
    change: (tx: Tx) => Effect.Effect<A, E, R>,
    scope?: TransactionScope,
  ) => Effect.Effect<A, E | CommitError, R>
  /** Receive every later commit's publication, in commit order, while the scope is open. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<CommitPublication>, never, Scope.Scope>
  /** Succeeds once the Session ended: its scope closed, or Storage failed it. */
  readonly ended: Effect.Effect<SessionEnd>
}

/** The Session kernel of a durable harness. */
export class Session extends Context.Service<Session, Service>()(
  'effect-harness/session/Session',
) {}

/** Open a Session over the `Storage` in context. Closing the scope closes the Session. */
export const make: Effect.Effect<Service, never, Storage | Scope.Scope> = internal.make

/** A `Session` over the `Storage` provided to the layer. */
export const layer: Layer.Layer<Session, never, Storage> = Layer.effect(Session, make)
