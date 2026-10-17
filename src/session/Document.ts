/**
 * Typed document definitions, ported from pi's `documents.ts`.
 *
 * A definition names a stable persisted `kind` and the `version` of its value shape, and says who
 * owns the document and how long it lives. A token wraps a definition and carries its value type;
 * `Tx.doc` and `Session.snapshot` take a token and the owner it is addressed under. A family is
 * keyed: each member has its own key and starts from a seed.
 */
import { Schema } from 'effect'
import type { Effect } from 'effect'
import { cast } from 'effect/Function'
import type { Draft } from '../delta/Tracker.ts'
import { DocumentCopySource, DocumentRecord, Op } from '../storage/schema/Document.ts'
import { ConversationId, NonNegativeInt } from '../storage/schema/Ids.ts'
import type { EntryId, TaskId } from '../storage/schema/Ids.ts'
import { JsonObject } from '../storage/schema/Json.ts'
import type { SnapshotError, TxDocumentError } from './Session.ts'

export const SessionSemantics = Schema.Struct({ scope: Schema.Literal('session') })
export type SessionSemantics = typeof SessionSemantics.Type

/** A conversation document that retains only its current state. */
export const LatestSemantics = Schema.Struct({
  scope: Schema.Literal('conversation'),
  history: Schema.Literal('latest'),
  /** A fork starts from the parent's current state, or from the initial value. */
  fork: Schema.Literals(['current', 'initial']),
})
export type LatestSemantics = typeof LatestSemantics.Type

/** A conversation document whose history stays addressable for as-of reads. */
export const RewindableSemantics = Schema.Struct({
  scope: Schema.Literal('conversation'),
  history: Schema.Literal('rewindable'),
  /** A fork starts as of its fork entry, from the parent's current state, or from the initial value. */
  fork: Schema.Literals(['asOf', 'current', 'initial']),
})
export type RewindableSemantics = typeof RewindableSemantics.Type

export const TaskSemantics = Schema.Struct({ scope: Schema.Literal('task') })
export type TaskSemantics = typeof TaskSemantics.Type

/** Who owns a document; only conversation documents declare history and fork behavior. */
export const Semantics = Schema.Union([
  SessionSemantics,
  LatestSemantics,
  RewindableSemantics,
  TaskSemantics,
])
export type Semantics = typeof Semantics.Type

/** Committed change of one document incarnation, as a commit publishes it. */
export const CommitChange = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('document'),
    record: DocumentRecord,
    /** Conversation owning the document; task documents take their task's. */
    conversationId: Schema.UndefinedOr(ConversationId),
    /** Definition version of `value`; absent when this commit retired the incarnation. */
    version: Schema.UndefinedOr(Schema.Int),
    /** Adopted revision, or `null` when this commit retired the incarnation. */
    value: Schema.NullOr(JsonObject),
    /** Adopted operations of an ordinary update; empty for creation and retirement. */
    ops: Schema.Array(Op),
  }),
  Schema.Struct({
    /** Definition-free child initialization of a fork. */
    type: Schema.Literal('document.copy'),
    record: DocumentRecord,
    conversationId: ConversationId,
    source: DocumentCopySource,
  }),
])
export type CommitChange = typeof CommitChange.Type

/** Stored replay state a checkpoint predicate decides on. */
export const CheckpointInfo = Schema.Struct({
  /** Deltas stored after the newest base, not counting the change being decided. */
  deltasSinceBase: NonNegativeInt,
})
export type CheckpointInfo = typeof CheckpointInfo.Type

/** Definition fields shared by singletons and families. */
export interface Common<T extends JsonObject> {
  /** Stable persisted kind; part of the public protocol. */
  readonly kind: string
  /** Positive integer version of the stored value shape. */
  readonly version: number
  /** Upgrade a value stored under an older `version`. Its result must be strict JSON. */
  readonly migrate?: (value: JsonObject, fromVersion: number) => T
  /** Return true to store this ordinary change as a complete base instead of a delta. */
  readonly checkpointWhen?: (
    value: Readonly<T>,
    ops: ReadonlyArray<Op>,
    info: CheckpointInfo,
  ) => boolean
}

/** A singleton document definition. */
export type Definition<T extends JsonObject, S extends Semantics = Semantics> = Common<T> &
  S & { readonly initial: () => T }

/** A keyed family definition; `initial(seed)` runs only when a member is absent. */
export type FamilyDefinition<
  T extends JsonObject,
  I extends Schema.Json,
  S extends Semantics = Semantics,
> = Common<T> & S & { readonly family: true; readonly initial: (seed: I) => T }

declare const valueType: unique symbol

/** A typed singleton document. */
export interface Token<T extends JsonObject, S extends Semantics> {
  readonly definition: Definition<T, S>
  readonly [valueType]?: T
}

/** A typed document family. */
export interface FamilyToken<T extends JsonObject, I extends Schema.Json, S extends Semantics> {
  readonly definition: FamilyDefinition<T, I, S>
  readonly [valueType]?: T
}

type ConversationSemantics = LatestSemantics | RewindableSemantics

export type SessionToken<T extends JsonObject> = Token<T, SessionSemantics>
export type ConversationToken<T extends JsonObject> = Token<T, ConversationSemantics>
export type RewindableToken<T extends JsonObject> = Token<T, RewindableSemantics>
export type TaskToken<T extends JsonObject> = Token<T, TaskSemantics>

export type SessionFamilyToken<T extends JsonObject, I extends Schema.Json> = FamilyToken<
  T,
  I,
  SessionSemantics
>
export type ConversationFamilyToken<T extends JsonObject, I extends Schema.Json> = FamilyToken<
  T,
  I,
  ConversationSemantics
>
export type RewindableFamilyToken<T extends JsonObject, I extends Schema.Json> = FamilyToken<
  T,
  I,
  RewindableSemantics
>
export type TaskFamilyToken<T extends JsonObject, I extends Schema.Json> = FamilyToken<
  T,
  I,
  TaskSemantics
>

/**
 * Define a singleton document. Its `version` is checked where the token is used: a version that
 * is not a positive integer fails every access with `DocumentError`.
 */
export const make: {
  <T extends JsonObject>(definition: Definition<T, SessionSemantics>): SessionToken<T>
  <T extends JsonObject>(definition: Definition<T, LatestSemantics>): ConversationToken<T>
  <T extends JsonObject>(definition: Definition<T, RewindableSemantics>): RewindableToken<T>
  <T extends JsonObject>(definition: Definition<T, TaskSemantics>): TaskToken<T>
} = cast(<T extends JsonObject>(definition: Definition<T>): Token<T, Semantics> => ({ definition }))

/** Define a keyed document family. */
export const makeFamily: {
  <T extends JsonObject, I extends Schema.Json>(
    definition: FamilyDefinition<T, I, SessionSemantics>,
  ): SessionFamilyToken<T, I>
  <T extends JsonObject, I extends Schema.Json>(
    definition: FamilyDefinition<T, I, LatestSemantics>,
  ): ConversationFamilyToken<T, I>
  <T extends JsonObject, I extends Schema.Json>(
    definition: FamilyDefinition<T, I, RewindableSemantics>,
  ): RewindableFamilyToken<T, I>
  <T extends JsonObject, I extends Schema.Json>(
    definition: FamilyDefinition<T, I, TaskSemantics>,
  ): TaskFamilyToken<T, I>
} = cast(
  <T extends JsonObject, I extends Schema.Json>(
    definition: FamilyDefinition<T, I>,
  ): FamilyToken<T, I, Semantics> => ({ definition }),
)

type DraftOf<T extends JsonObject> = Effect.Effect<Draft<T>, TxDocumentError>

/**
 * Acquire a document's draft for this transaction, creating the incarnation from the
 * definition's `initial` when the address has none. A family member takes a seed, used only when
 * it is created. Edits to the draft commit with the transaction.
 */
export interface Acquire {
  <T extends JsonObject>(token: SessionToken<T>): DraftOf<T>
  <T extends JsonObject>(token: ConversationToken<T>, conversationId: ConversationId): DraftOf<T>
  <T extends JsonObject>(token: TaskToken<T>, taskId: TaskId): DraftOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: SessionFamilyToken<T, I>,
    key: string,
    seed: I,
  ): DraftOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: ConversationFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
    seed: I,
  ): DraftOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: TaskFamilyToken<T, I>,
    taskId: TaskId,
    key: string,
    seed: I,
  ): DraftOf<T>
}

/**
 * Retire a document's current incarnation in this commit; an acquired draft's final content is
 * written first. Acquiring the address again creates a new incarnation.
 */
export interface Retire {
  <T extends JsonObject>(token: SessionToken<T>): Effect.Effect<void, TxDocumentError>
  <T extends JsonObject>(
    token: ConversationToken<T>,
    conversationId: ConversationId,
  ): Effect.Effect<void, TxDocumentError>
  <T extends JsonObject>(token: TaskToken<T>, taskId: TaskId): Effect.Effect<void, TxDocumentError>
  <T extends JsonObject, I extends Schema.Json>(
    token: SessionFamilyToken<T, I>,
    key: string,
  ): Effect.Effect<void, TxDocumentError>
  <T extends JsonObject, I extends Schema.Json>(
    token: ConversationFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
  ): Effect.Effect<void, TxDocumentError>
  <T extends JsonObject, I extends Schema.Json>(
    token: TaskFamilyToken<T, I>,
    taskId: TaskId,
    key: string,
  ): Effect.Effect<void, TxDocumentError>
}

type SnapshotOf<T extends JsonObject> = Effect.Effect<Readonly<T> | undefined, SnapshotError>

/** Read a document's committed value; never creates one. Absent documents read `undefined`. */
export interface Snapshot {
  <T extends JsonObject>(token: SessionToken<T>): SnapshotOf<T>
  <T extends JsonObject>(token: ConversationToken<T>, conversationId: ConversationId): SnapshotOf<T>
  <T extends JsonObject>(token: TaskToken<T>, taskId: TaskId): SnapshotOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: SessionFamilyToken<T, I>,
    key: string,
  ): SnapshotOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: ConversationFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
  ): SnapshotOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: TaskFamilyToken<T, I>,
    taskId: TaskId,
    key: string,
  ): SnapshotOf<T>
}

/**
 * Read a rewindable conversation document as of the commit of an entry visible from
 * `conversationId`, following fork ancestry. Fails when the entry is not visible.
 */
export interface SnapshotAsOf {
  <T extends JsonObject>(
    token: RewindableToken<T>,
    conversationId: ConversationId,
    at: EntryId,
  ): SnapshotOf<T>
  <T extends JsonObject, I extends Schema.Json>(
    token: RewindableFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
    at: EntryId,
  ): SnapshotOf<T>
}
