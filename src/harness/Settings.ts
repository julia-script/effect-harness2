/**
 * Harness-wide run policy, ported from pi's `HarnessSettings`. The Harness and the generation task
 * both read the `Current` settings, at every use, so a host can change them while it runs.
 */
import { Context, Effect, Layer, Schema } from 'effect'
import * as Model from '../model/Model.ts'

/** How many queued items of one mode a boundary places: the first, or all of them. */
export const QueueMode = Schema.Literals(['all', 'one-at-a-time'])
export type QueueMode = typeof QueueMode.Type

/** Whether a tool round runs its calls together, or one after another in call order. */
export const ToolExecution = Schema.Literals(['parallel', 'sequential'])
export type ToolExecution = typeof ToolExecution.Type

/** Durable retries of a generation attempt that failed `Retryable`. */
export const Retry = Schema.Struct({
  enabled: Schema.Boolean,
  /** Retries after the first attempt. */
  maxRetries: Schema.Finite,
  /** The delay before retry `n` is `baseDelayMs · 2^(n−1)`, at most `maxDelayMs`. */
  baseDelayMs: Schema.Finite,
  maxDelayMs: Schema.Finite,
})
export type Retry = typeof Retry.Type

/** Resolved settings: every field set. */
export const Settings = Schema.Struct({
  /** Steers a boundary places. Default: `one-at-a-time`. */
  steeringMode: QueueMode,
  /** Follow-ups a final boundary places. Default: `one-at-a-time`. */
  followUpMode: QueueMode,
  /** Default: parallel. */
  toolExecution: ToolExecution,
  /** Default: enabled, 3 retries, from 2 s up to 60 s. */
  retry: Retry,
  /** Request options of every generation; the generation sets `sessionId` and `reasoning`. */
  stream: Model.Options,
  /** Minimum pause between commits of the answer being generated. Default: 100 ms. */
  partialIntervalMs: Schema.Finite,
})
export type Settings = typeof Settings.Type

/** Host settings: any field may be left to its default, `retry` field by field. */
export const Input = Schema.Struct({
  steeringMode: Schema.optionalKey(QueueMode),
  followUpMode: Schema.optionalKey(QueueMode),
  toolExecution: Schema.optionalKey(ToolExecution),
  retry: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      maxRetries: Schema.optionalKey(Schema.Finite),
      baseDelayMs: Schema.optionalKey(Schema.Finite),
      maxDelayMs: Schema.optionalKey(Schema.Finite),
    }),
  ),
  stream: Schema.optionalKey(Model.Options),
  partialIntervalMs: Schema.optionalKey(Schema.Finite),
})
export type Input = typeof Input.Type

export const defaults: Settings = {
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  toolExecution: 'parallel',
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60_000 },
  stream: {},
  partialIntervalMs: 100,
}

/** Every field of `input` over its default. */
export const resolve = (input: Input = {}): Settings => ({
  steeringMode: input.steeringMode ?? defaults.steeringMode,
  followUpMode: input.followUpMode ?? defaults.followUpMode,
  toolExecution: input.toolExecution ?? defaults.toolExecution,
  retry: { ...defaults.retry, ...input.retry },
  stream: input.stream ?? defaults.stream,
  partialIntervalMs: input.partialIntervalMs ?? defaults.partialIntervalMs,
})

/** The delay before retry `attempt`, counted from 1. */
export const retryDelayMs = (retry: Retry, attempt: number): number =>
  Math.min(retry.baseDelayMs * 2 ** Math.max(0, attempt - 1), retry.maxDelayMs)

/** The settings at this use: `defaults` unless a layer provides others. */
export const Current: Context.Reference<Effect.Effect<Settings>> = Context.Reference(
  'effect-harness/harness/Settings/Current',
  { defaultValue: () => Effect.succeed(defaults) },
)

/** `input`, or an Effect read at every use, resolved over the defaults. */
export const make = (input: Input | Effect.Effect<Input>): Effect.Effect<Settings> =>
  Effect.isEffect(input) ? Effect.map(input, resolve) : Effect.succeed(resolve(input))

/** Provide `Current`, for the Harness and the generation task together. */
export const layer = (input: Input | Effect.Effect<Input>): Layer.Layer<never> =>
  Layer.succeed(Current, make(input))
