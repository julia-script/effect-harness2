/**
 * The Harness protocol: every request a client sends the loop, declared as Schemas. It imports
 * no runtime: a client depends on it, and on a transport, and on nothing the loop runs.
 */
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import {
  ConversationBusy,
  InitFailed,
  InvalidSubmission,
  SubmissionNotFound,
} from '../harness/HarnessError.ts'
import { Change, View } from '../harness/AgentState.ts'
import { AbortResult, Draft, Settled } from '../harness/Submission.ts'
import {
  DocumentError,
  SessionClosed,
  SessionFailed,
  TransactionError,
} from '../session/SessionError.ts'
import { ConversationOwnership } from '../storage/schema/Conversation.ts'
import { EntryRecord } from '../storage/schema/Entry.ts'
import { ConversationId, EntryId, SubmissionId, TaskId } from '../storage/schema/Ids.ts'
import { Cursor, EntryQuery, Page } from '../storage/schema/Scan.ts'
import { SubmissionRecord } from '../storage/schema/Submission.ts'
import { StorageError, StorageRequestError } from '../storage/StorageError.ts'
import { Inspection as SchedulerInspection } from '../task/Inspection.ts'
import { SchedulerClosed, TaskNotFound } from '../task/TaskError.ts'
import { Call } from './Init.ts'

/** Live work: scheduling state, every live task, and the queued and placed submissions. */
export const Inspection = Schema.Struct({
  ...SchedulerInspection.fields,
  /** In ID order. */
  submissions: Schema.Array(SubmissionRecord),
})
export type Inspection = typeof Inspection.Type

/** How a commit on the loop fails. */
export const CommitError = Schema.Union([
  TransactionError,
  SessionFailed,
  DocumentError,
  SessionClosed,
  StorageRequestError,
])

/** A conversation scan, without the conversation it scans. */
export const ConversationEntryQuery = Schema.Struct({
  minEntryId: EntryQuery.fields.minEntryId,
  maxEntryId: EntryQuery.fields.maxEntryId,
  order: EntryQuery.fields.order,
})
export type ConversationEntryQuery = typeof ConversationEntryQuery.Type

/** The result of creating, forking, or opening a conversation: its ID. */
const created = {
  success: ConversationId,
  error: Schema.Union([CommitError, InitFailed]),
}

const submission = { submissionId: SubmissionId }

export class HarnessRpcs extends RpcGroup.make(
  /** The reserved root conversation, created with `init` when absent. */
  Rpc.make('Root', { payload: { init: Schema.optionalKey(Call) }, ...created }),
  Rpc.make('CreateConversation', {
    payload: { ownership: ConversationOwnership, init: Schema.optionalKey(Call) },
    ...created,
  }),
  Rpc.make('Fork', {
    payload: {
      conversationId: ConversationId,
      at: EntryId,
      ownership: ConversationOwnership,
      init: Schema.optionalKey(Call),
    },
    ...created,
  }),
  /** Whether the conversation exists. */
  Rpc.make('HasConversation', {
    payload: { conversationId: ConversationId },
    success: Schema.Boolean,
    error: CommitError,
  }),
  Rpc.make('Submit', {
    payload: { conversationId: ConversationId, draft: Draft },
    success: SubmissionId,
    error: Schema.Union([CommitError, ConversationBusy, InvalidSubmission]),
  }),
  Rpc.make('Reset', {
    payload: { conversationId: ConversationId, handoff: Schema.optionalKey(Schema.String) },
    success: SubmissionId,
    error: CommitError,
  }),
  Rpc.make('Compact', {
    payload: { conversationId: ConversationId, instructions: Schema.optionalKey(Schema.String) },
    success: TaskId,
    error: CommitError,
  }),
  Rpc.make('Configure', {
    payload: { conversationId: ConversationId, change: Change },
    error: CommitError,
  }),
  Rpc.make('Agent', {
    payload: { conversationId: ConversationId },
    success: View,
    error: CommitError,
  }),
  Rpc.make('Entries', {
    payload: {
      conversationId: ConversationId,
      query: ConversationEntryQuery,
      limit: Schema.Int,
      cursor: Schema.optionalKey(Cursor),
    },
    success: Page(EntryRecord),
    error: CommitError,
  }),
  Rpc.make('AbortConversation', {
    payload: { conversationId: ConversationId, background: Schema.optionalKey(Schema.Boolean) },
    error: Schema.Union([CommitError, TaskNotFound, SchedulerClosed, StorageError]),
  }),
  Rpc.make('WaitForIdle', {
    payload: { conversationId: ConversationId },
    error: Schema.Union([CommitError, SchedulerClosed]),
  }),
  /** Whether the submission exists. */
  Rpc.make('HasSubmission', { payload: submission, success: Schema.Boolean, error: CommitError }),
  Rpc.make('SubmissionStatus', {
    payload: submission,
    success: SubmissionRecord,
    error: Schema.Union([CommitError, SubmissionNotFound]),
  }),
  /** Wait until the submission settles; interrupting the wait leaves the submission. */
  Rpc.make('WaitSubmission', {
    payload: submission,
    success: Settled,
    error: Schema.Union([CommitError, SubmissionNotFound]),
  }),
  /** Withdraw a queued submission; `not_found` when it is not one of `conversationId`. */
  Rpc.make('AbortSubmission', {
    payload: { ...submission, conversationId: Schema.optionalKey(ConversationId) },
    success: Schema.Union([AbortResult, Schema.Literal('not_found')]),
    error: CommitError,
  }),
  Rpc.make('Inspect', {
    success: Inspection,
    error: Schema.Union([CommitError, StorageError]),
  }),
) {}
