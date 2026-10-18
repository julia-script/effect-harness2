/**
 * The client of a Harness: what calling code uses. It sends `HarnessRpcs` over the
 * `RpcClient.Protocol` in context, so it runs wherever the loop's transport reaches, the same
 * process included, and imports nothing the loop runs.
 */
import { Context, Effect, Layer, Option, Schema, Sink, Stream } from 'effect'
import type { Scope } from 'effect'
import { RpcClient } from 'effect/rpc'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Ops from '../delta/Ops.ts'
import type * as AgentEvent from '../harness/AgentEvent.ts'
import { SubmissionNotFound } from '../harness/HarnessError.ts'
import type { ConversationBusy, InitFailed, InvalidSubmission } from '../harness/HarnessError.ts'
import type * as AgentState from '../harness/AgentState.ts'
import type { AbortResult, Draft, Settled } from '../harness/Submission.ts'
import type { Change, ConversationView, TaskGraph, Watch } from '../harness/ViewState.ts'
import type { Op } from '../storage/schema/Document.ts'
import type { CommitError } from '../session/SessionError.ts'
import type { ConversationOwnership } from '../storage/schema/Conversation.ts'
import type { EntryRecord } from '../storage/schema/Entry.ts'
import type { ConversationId, EntryId, SubmissionId, TaskId } from '../storage/schema/Ids.ts'
import type { Cursor, Page } from '../storage/schema/Scan.ts'
import type { SubmissionRecord } from '../storage/schema/Submission.ts'
import type { StorageError } from '../storage/StorageError.ts'
import type { SchedulerClosed, TaskNotFound } from '../task/TaskError.ts'
import { HarnessRpcs } from './HarnessRpcs.ts'
import type { ConversationEntryQuery, Inspection } from './HarnessRpcs.ts'
import type { Bound, Call } from './Init.ts'

/** How a call fails on the loop, or on the way there. */
export type Failure<E = never> = E | CommitError | RpcClientError

/** Handle of one submission, by ID. */
export interface Submission {
  readonly id: SubmissionId
  /** The committed record. */
  readonly status: Effect.Effect<SubmissionRecord, Failure<SubmissionNotFound>>
  /** Wait until it settles; interrupting the wait leaves the submission as it is. */
  readonly wait: Effect.Effect<Settled, Failure<SubmissionNotFound>>
  /** Withdraw it while queued; placed and settled ones stay as they are. */
  readonly abort: Effect.Effect<AbortResult, Failure<SubmissionNotFound>>
}

export interface CreateOptions {
  readonly ownership: ConversationOwnership
  /** A named `init` the loop runs in the creating commit. */
  readonly init?: Bound
}

/** Handle of one conversation, by ID. */
export interface Conversation {
  readonly id: ConversationId
  readonly submit: (
    draft: Draft,
  ) => Effect.Effect<Submission, Failure<ConversationBusy | InvalidSubmission>>
  /** Start fresh context at a `pi.reset` entry, with optional handoff text. */
  readonly reset: (handoff?: string) => Effect.Effect<Submission, Failure>
  /** Start a manual compaction; its summary is placed at the next boundary, or at once when idle. */
  readonly compact: (instructions?: string) => Effect.Effect<TaskId, Failure>
  /** Change what the conversation asks with: a given field replaces it, `null` clears it. */
  readonly configure: (change: AgentState.Change) => Effect.Effect<void, Failure>
  /** The agent its next request would resolve, by name. */
  readonly agent: Effect.Effect<AgentState.View, Failure>
  readonly entries: (
    query: ConversationEntryQuery,
    limit: number,
    cursor?: Cursor,
  ) => Effect.Effect<Page<EntryRecord>, Failure>
  /** Watch its active transcript and built-in documents while the scope is open. */
  readonly view: Effect.Effect<Watch<ConversationView, Failure>, Failure, Scope.Scope>
  /** Watch its agent events, from a snapshot, while the scope is open. */
  readonly events: Effect.Effect<AgentEvent.Events<Failure>, Failure, Scope.Scope>
  readonly fork: (
    at: EntryId,
    options: CreateOptions,
  ) => Effect.Effect<Conversation, Failure<InitFailed>>
  /** Abort its live work; `background` includes background tasks. */
  readonly abort: (options?: {
    readonly background?: boolean
  }) => Effect.Effect<void, Failure<TaskNotFound | SchedulerClosed | StorageError>>
  readonly waitForIdle: Effect.Effect<void, Failure<SchedulerClosed>>
}

export interface Service {
  /** The reserved root conversation, created with `init` when absent. */
  readonly root: (options?: {
    readonly init?: Bound
  }) => Effect.Effect<Conversation, Failure<InitFailed>>
  readonly conversation: (id: ConversationId) => Effect.Effect<Conversation | undefined, Failure>
  readonly createConversation: (
    options: CreateOptions,
  ) => Effect.Effect<Conversation, Failure<InitFailed>>
  /** Reacquire a submission, for example after a restart. */
  readonly submission: (id: SubmissionId) => Effect.Effect<Submission | undefined, Failure>
  /** Withdraw a queued submission; `not_found` when it is not one of `conversationId`. */
  readonly abortSubmission: (
    id: SubmissionId,
    conversationId?: ConversationId,
  ) => Effect.Effect<AbortResult | 'not_found', Failure>
  /** Live tasks and unsettled submissions. */
  readonly inspect: Effect.Effect<Inspection, Failure<StorageError>>
  /** Watch every live task while the scope is open. */
  readonly taskGraph: Effect.Effect<Watch<TaskGraph, Failure>, Failure, Scope.Scope>
}

export class HarnessClient extends Context.Service<HarnessClient, Service>()(
  'effect-harness/client/HarnessClient',
) {}

type Rpcs = RpcClient.FromGroup<typeof HarnessRpcs, RpcClientError>

/** The wire form of a bound `init`: its payload encoded by its own Schema. */
const encodeInit = (bound: Bound | undefined): Effect.Effect<{ readonly init?: Call }> =>
  bound === undefined
    ? Effect.succeed({})
    : Effect.map(
        // The payload is typed by the Schema that encodes it.
        Effect.orDie(Schema.encodeEffect(bound.init.payload)(bound.payload)),
        (payload) => ({ init: { name: bound.init.name, payload } }),
      )

/** The loop broke the protocol of a watch. */
const broken = (message: string) =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause: undefined }) })

/** The first element of `stream`, and the rest, while the scope is open. */
const first = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.flatMap(Stream.peel(stream, Sink.head<A>()), ([head, rest]) =>
    Option.isNone(head)
      ? Effect.fail(broken('The loop ended a watch before its first frame'))
      : Effect.succeed([head.value, rest] as const),
  )

type Frame<T> =
  | { readonly type: 'value'; readonly value: T }
  | { readonly type: 'change'; readonly ops: ReadonlyArray<Op> }

/** The next value and change of a watch after one frame. */
const replay = <T extends Schema.Json>(value: T, frame: Frame<T>): readonly [T, Change<T>] => {
  if (frame.type === 'value')
    return [frame.value, { value: frame.value, ops: [['r', frame.value]] }]
  const next = Ops.apply(value, frame.ops)
  return [next, { value: next, ops: frame.ops }]
}

/** A watch from its frames: the value they start with, then each change replayed onto it. */
const watched = <T extends Schema.Json, E>(frames: Stream.Stream<Frame<T>, E>) =>
  Effect.flatMap(first(frames), ([head, rest]) =>
    head.type === 'value'
      ? Effect.succeed<Watch<T, E>>({
          value: head.value,
          changes: Stream.mapAccum(
            rest,
            () => head.value,
            (value, frame) => {
              const [next, change] = replay(value, frame)
              return [next, [change]]
            },
          ),
        })
      : Effect.fail(broken('The loop started a watch without its value')),
  )

/** Events from their batches: the first holds the snapshot. */
const eventsFrom = <E>(batches: Stream.Stream<ReadonlyArray<AgentEvent.AgentEvent>, E>) =>
  Effect.flatMap(first(batches), ([head, rest]) => {
    const snapshot = head[0]
    return snapshot?.type === 'snapshot'
      ? Effect.succeed<AgentEvent.Events<E>>({ snapshot, batches: rest })
      : Effect.fail(broken('The loop started events without a snapshot'))
  })

const submissionHandle = (rpcs: Rpcs, id: SubmissionId): Submission => ({
  id,
  status: rpcs.SubmissionStatus({ submissionId: id }),
  wait: rpcs.WaitSubmission({ submissionId: id }),
  abort: rpcs.AbortSubmission({ submissionId: id }).pipe(
    Effect.filterOrFail(
      (result): result is AbortResult => result !== 'not_found',
      () =>
        new SubmissionNotFound({ message: `Submission ${id} does not exist`, submissionId: id }),
    ),
  ),
})

const conversationHandle = (rpcs: Rpcs, id: ConversationId): Conversation => ({
  id,
  submit: (draft) =>
    Effect.map(rpcs.Submit({ conversationId: id, draft }), (submissionId) =>
      submissionHandle(rpcs, submissionId),
    ),
  reset: (handoff) =>
    Effect.map(
      rpcs.Reset({ conversationId: id, ...(handoff === undefined ? {} : { handoff }) }),
      (submissionId) => submissionHandle(rpcs, submissionId),
    ),
  compact: (instructions) =>
    rpcs.Compact({
      conversationId: id,
      ...(instructions === undefined ? {} : { instructions }),
    }),
  configure: (change) => rpcs.Configure({ conversationId: id, change }),
  agent: rpcs.Agent({ conversationId: id }),
  entries: (query, limit, cursor) =>
    rpcs.Entries({ conversationId: id, query, limit, ...(cursor === undefined ? {} : { cursor }) }),
  view: watched(rpcs.WatchView({ conversationId: id })),
  events: eventsFrom(rpcs.WatchEvents({ conversationId: id })),
  fork: (at, { ownership, init }) =>
    encodeInit(init).pipe(
      Effect.flatMap((encoded) => rpcs.Fork({ conversationId: id, at, ownership, ...encoded })),
      Effect.map((forked) => conversationHandle(rpcs, forked)),
    ),
  abort: (options) => rpcs.AbortConversation({ conversationId: id, ...options }),
  waitForIdle: rpcs.WaitForIdle({ conversationId: id }),
})

/** A client over the `RpcClient.Protocol` in context, for the lifetime of the scope. */
export const make: Effect.Effect<Service, never, RpcClient.Protocol | Scope.Scope> = Effect.map(
  RpcClient.make(HarnessRpcs),
  (rpcs): Service => ({
    root: (options) =>
      encodeInit(options?.init).pipe(
        Effect.flatMap(rpcs.Root),
        Effect.map((id) => conversationHandle(rpcs, id)),
      ),
    conversation: (id) =>
      Effect.map(rpcs.HasConversation({ conversationId: id }), (exists) =>
        exists ? conversationHandle(rpcs, id) : undefined,
      ),
    createConversation: ({ ownership, init }) =>
      encodeInit(init).pipe(
        Effect.flatMap((encoded) => rpcs.CreateConversation({ ownership, ...encoded })),
        Effect.map((id) => conversationHandle(rpcs, id)),
      ),
    submission: (id) =>
      Effect.map(rpcs.HasSubmission({ submissionId: id }), (exists) =>
        exists ? submissionHandle(rpcs, id) : undefined,
      ),
    abortSubmission: (id, conversationId) =>
      rpcs.AbortSubmission({
        submissionId: id,
        ...(conversationId === undefined ? {} : { conversationId }),
      }),
    inspect: rpcs.Inspect(),
    taskGraph: watched(rpcs.WatchTaskGraph()),
  }),
)

/** `make` as a Layer: needs the client end of a transport, such as `HarnessTransport.layerMemory`. */
export const layer: Layer.Layer<HarnessClient, never, RpcClient.Protocol> = Layer.effect(
  HarnessClient,
  make,
)
