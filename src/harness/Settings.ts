/**
 * Harness-wide run policy, ported from pi's `HarnessSettings`. The Harness reads its settings at
 * every use, so a host can change them while it runs.
 */
import { Schema } from 'effect'

/** How many queued items of one mode a boundary places: the first, or all of them. */
export const QueueMode = Schema.Literals(['all', 'one-at-a-time'])
export type QueueMode = typeof QueueMode.Type

/** Resolved settings: every field set. */
export const Settings = Schema.Struct({
  /** Steers a boundary places. Default: `one-at-a-time`. */
  steeringMode: QueueMode,
  /** Follow-ups a final boundary places. Default: `one-at-a-time`. */
  followUpMode: QueueMode,
})
export type Settings = typeof Settings.Type

/** Host settings: any field may be left to its default. */
export const Input = Schema.Struct({
  steeringMode: Schema.optionalKey(QueueMode),
  followUpMode: Schema.optionalKey(QueueMode),
})
export type Input = typeof Input.Type

export const defaults: Settings = { steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' }

/** Every field of `input` over its default. */
export const resolve = (input: Input = {}): Settings => ({
  steeringMode: input.steeringMode ?? defaults.steeringMode,
  followUpMode: input.followUpMode ?? defaults.followUpMode,
})
