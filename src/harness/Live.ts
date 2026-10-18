/**
 * The built-in `pi.live` document, ported from pi's `harness/live.ts`: run control of one
 * conversation, and the presentation of its running generation and tool round.
 */
import { Effect, Schema } from 'effect'
import { AssistantMessage } from '../model/Message.ts'
import * as Document from '../session/Document.ts'
import { EntryId, SubmissionId, TaskId } from '../storage/schema/Ids.ts'

/** The task that settles a run's inputs, and those inputs. */
export const Run = Schema.Struct({ taskId: TaskId, inputs: Schema.Array(SubmissionId) })
export type Run = typeof Run.Type

/** The current generation attempt. */
export const Generation = Schema.Struct({
  attempt: Schema.Finite,
  /** The committed, throttled partial of the response being generated. */
  message: Schema.optionalKey(AssistantMessage),
  /** Durable backoff before the next attempt. */
  retry: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, error: Schema.String })),
  /** A deferred response being polled. */
  deferred: Schema.optionalKey(Schema.Struct({ pollAt: Schema.Finite })),
})
export type Generation = typeof Generation.Type

/** One call of the current tool round. */
export const ToolSlot = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(['pending', 'running', 'done']),
  /**
   * Absent for a call not started yet (sequential round), and for a call its request did not
   * offer, which starts `done` with the result the generation wrote.
   */
  taskId: Schema.optionalKey(TaskId),
  /** The result entry once done; absent when the tool task faulted or was orphaned. */
  entry: Schema.optionalKey(EntryId),
})
export type ToolSlot = typeof ToolSlot.Type

export const State = Schema.Struct({
  /** Present exactly while the conversation is busy. */
  run: Schema.optionalKey(Run),
  generation: Schema.optionalKey(Generation),
  /** The current tool round in call order, from the tool-calling answer until the round ends. */
  tools: Schema.optionalKey(Schema.Array(ToolSlot)),
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
  // A complete base whenever nothing streams into the document (spec §8.2): no generation and no
  // running call, so the delta chain spans at most one attempt or one round.
  checkpointWhen: (value) =>
    Effect.succeed(
      value.generation === undefined &&
        !(value.tools ?? []).some((slot) => slot.status === 'running'),
    ),
})
