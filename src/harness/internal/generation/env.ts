/**
 * What the phases of the generation task close over, and helpers they share.
 */
import { Clock, Effect } from 'effect'
import type * as Model from '../../../model/Model.ts'
import type { EntryId } from '../../../storage/schema/Ids.ts'
import type { NextState, Runtime } from '../../../task/Task.ts'
import type { Agent, Checkpoint, Result } from '../../Generation.ts'
import type { Settings } from '../../Settings.ts'
import { read } from '../context.ts'
import type { View } from '../context.ts'

export interface Env {
  readonly model: Model.Service
  readonly settings: Effect.Effect<Settings>
  readonly agent: Effect.Effect<Agent>
}

export type GenerationRuntime = Runtime<Record<string, never>, Checkpoint, Result>
export type Next = NextState<Checkpoint, Result>

/** The committed context, now or cut off at `at`, read in a commit of its own. */
export const readView = (runtime: GenerationRuntime, at?: EntryId) =>
  Effect.suspend(() => {
    let view: View = { head: undefined, entries: [], messages: [] }
    return runtime
      .commit((tx) =>
        Effect.map(read(tx, runtime.conversationId, at), (current) => {
          view = current
        }),
      )
      .pipe(Effect.map(() => view))
  })

/** Sleep until the epoch millisecond `at`. */
export const sleepUntil = (at: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Math.max(0, at - now)))
