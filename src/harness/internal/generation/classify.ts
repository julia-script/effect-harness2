/**
 * What a response means for the run: poll it, retry, answer, start a tool round, or end the run.
 */
import { Clock, Effect, Result } from 'effect'
import type { AssistantMessage, Message } from '../../../model/Message.ts'
import type * as Model from '../../../model/Model.ts'
import { Retryable, UnknownModel } from '../../../model/ModelError.ts'
import type { ModelError } from '../../../model/ModelError.ts'
import * as Transcript from '../../../model/Transcript.ts'
import type { EntryId } from '../../../storage/schema/Ids.ts'
import * as Live from '../../Live.ts'
import { retryDelayMs } from '../../Settings.ts'
import { prepareBoundary } from '../inbox.ts'
import { appendAssistant, endRun, finishRun } from '../run.ts'
import type { Env, GenerationRuntime, Next } from './env.ts'
import { startToolRound } from './round.ts'

const DEFAULT_POLL_AFTER_MS = 5000

/** What classification needs of the request that produced a response. */
export interface Request {
  readonly attempt: number
  readonly model: Model.Ref
  readonly cutoff: EntryId
  /** The context through `cutoff`, when the phase already read it. */
  readonly messages?: ReadonlyArray<Message>
  /** Set when the response came from polling, so a still deferred one polls strictly later. */
  readonly pollAt?: number
}

/**
 * End the run `unanswered` with `reason` and fail the task with `message`, appending the
 * provider's `response` first when there is one.
 */
export const fail = (
  runtime: GenerationRuntime,
  reason: 'model_error' | 'no_model',
  message: string,
  response?: AssistantMessage,
) =>
  runtime.commit((tx) =>
    Effect.gen(function* () {
      const live = yield* tx.doc(Live.document, runtime.conversationId)
      if (response !== undefined) yield* appendAssistant(tx, runtime.conversationId, response)
      const detail = reason === 'model_error' ? { detail: message } : {}
      yield* endRun(tx, live, runtime.taskId, { status: 'unanswered', reason, ...detail })
      const error = { message, detail: { reason } }
      const next: Next = { status: 'terminal', outcome: { status: 'failed', error } }
      return next
    }),
  )

/** End the run `unanswered` with `no_model`. */
export const failNoModel = (runtime: GenerationRuntime, ref: Model.Ref | undefined) =>
  fail(
    runtime,
    'no_model',
    ref === undefined
      ? 'No model is configured'
      : `Model ${ref.provider}/${ref.modelId} is not available`,
  )

/** A final answer: the final boundary places queued items, and the run's inputs settle `done`. */
const answer = (runtime: GenerationRuntime, env: Env, message: AssistantMessage) =>
  runtime.commit((tx) =>
    Effect.gen(function* () {
      const { conversationId } = runtime
      // Queue modes are read on the line, when the boundary is decided.
      const boundary = yield* prepareBoundary(tx, conversationId, yield* env.settings)
      const entry = yield* appendAssistant(tx, conversationId, message)
      yield* finishRun(tx, boundary, runtime.taskId, entry.id)
      const next: Next = {
        status: 'terminal',
        outcome: { status: 'completed', result: { entryId: entry.id } },
      }
      return next
    }),
  )

/** Poll a deferred response at `pollAfterMs`, and strictly after the previous poll. */
const poll = (runtime: GenerationRuntime, request: Request, message: AssistantMessage) =>
  Effect.gen(function* () {
    const handle = message.deferred
    if (handle === undefined) return
    const now = yield* Clock.currentTimeMillis
    const pollAt = Math.max(
      now + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
      request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
    )
    const { attempt, model, cutoff } = request
    yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(Live.document, runtime.conversationId)
        live.generation = { attempt, deferred: { pollAt } }
        const next: Next = {
          status: 'running',
          checkpoint: { phase: 'poll', attempt, model, cutoff, handle, pollAt },
        }
        return next
      }),
    )
  })

/**
 * A failed request: an unknown model ends the run `no_model`; a `Retryable` failure waits and
 * tries again while the retry policy allows; anything else ends the run `model_error`. The
 * policy is read now, since it governs the next attempt.
 */
const failed = (runtime: GenerationRuntime, env: Env, request: Request, error: ModelError) =>
  Effect.gen(function* () {
    if (error.reason instanceof UnknownModel) return yield* failNoModel(runtime, request.model)
    const { retry } = yield* env.settings
    const { attempt } = request
    if (!(error.reason instanceof Retryable && retry.enabled && attempt <= retry.maxRetries))
      return yield* fail(runtime, 'model_error', error.message, error.response)
    const delay = Math.max(error.reason.retryAfterMs ?? 0, retryDelayMs(retry, attempt))
    const until = (yield* Clock.currentTimeMillis) + delay
    return yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(Live.document, runtime.conversationId)
        if (error.response !== undefined)
          yield* appendAssistant(tx, runtime.conversationId, error.response)
        live.generation = { attempt, retry: { at: until, error: error.message } }
        const next: Next = { status: 'running', checkpoint: { phase: 'retry', attempt, until } }
        return next
      }),
    )
  })

/** Classify a request's outcome in one commit that also replaces the partial. */
export const classify = (
  runtime: GenerationRuntime,
  env: Env,
  request: Request,
  outcome: Result.Result<AssistantMessage, ModelError>,
) =>
  Effect.gen(function* () {
    if (Result.isFailure(outcome)) return yield* failed(runtime, env, request, outcome.failure)
    const message = outcome.success
    const { stopReason } = message
    if (stopReason === 'deferred' && message.deferred !== undefined)
      return yield* poll(runtime, request, message)
    const calls = Transcript.toolCalls(message)
    if (stopReason === 'toolUse' && calls.length > 0)
      return yield* startToolRound(runtime, env, request, message, calls)
    if (stopReason === 'stop' || stopReason === 'length' || stopReason === 'toolUse')
      return yield* answer(runtime, env, message)
    const text = message.errorMessage ?? `Model response ended with stop reason ${stopReason}`
    return yield* fail(runtime, 'model_error', text, message)
  })
