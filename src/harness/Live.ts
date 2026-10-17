/**
 * The built-in `pi.live` document, ported from pi's `harness/live.ts`: run control of one
 * conversation. The presentation of the running generation and its tool round joins it with the
 * built-in tasks.
 */
import { Effect, Schema } from 'effect'
import * as Document from '../session/Document.ts'
import { SubmissionId, TaskId } from '../storage/schema/Ids.ts'

/** The task that settles a run's inputs, and those inputs. */
export const Run = Schema.Struct({ taskId: TaskId, inputs: Schema.Array(SubmissionId) })
export type Run = typeof Run.Type

export const State = Schema.Struct({
  /** Present exactly while the conversation is busy. */
  run: Schema.optionalKey(Run),
})
export type State = typeof State.Type

/** One per conversation; every fork starts idle. */
export const document = Document.make<State>({
  kind: 'pi.live',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => Effect.succeed({}),
  // While nothing streams into the document every change is a complete base (spec §8.2).
  checkpointWhen: () => Effect.succeed(true),
})
