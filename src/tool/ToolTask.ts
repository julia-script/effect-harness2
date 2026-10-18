/**
 * The built-in tool task, ported from pi's `ToolTask` (`harness/tool.ts`): one durable task per
 * model-issued tool call.
 *
 * Its `call` phase reads the call from its assistant entry, resolves the tool, validates the
 * arguments against the tool's parameters Schema, records intent (the arguments it runs with and
 * the replay policy), runs the handler, and settles: a `pi.tool-result` entry and the task's
 * outcome in one commit. Every way a call can go wrong still answers it with a result entry, so
 * the model always sees one:
 *
 * - `tool_unavailable`: no tool of that name, or no handler for it.
 * - `invalid_arguments`: the arguments do not decode.
 * - The tool's declared failure: an error result with the encoded failure; the task completes.
 * - `tool_error`: the handler died, failed with an `AiError`, or returned a value its Schema
 *   cannot encode; the task ends `failed`.
 * - `interrupted`: a crash stopped the call after intent and the tool is not replay-safe; on
 *   recovery the `execute` phase answers it instead of running it again. A replay-safe tool
 *   (annotated `Tool.Idempotent`, both when intent was recorded and now) runs again.
 * - `aborted`, or on an abandon after restart `interrupted` and `abandoned`: the abort handler.
 *
 * The task needs no services: `make` closes over the handlers, and `layer` installs it in the
 * `Registry` from the handlers a `Toolkit.toLayer()` provides.
 */
import { Effect, Layer, Schema } from 'effect'
import type { Context } from 'effect'
import type { Tool, Toolkit } from 'effect/ai'
import type { TaskKind } from '../session/Session.ts'
import { EntryId } from '../storage/schema/Ids.ts'
import { JsonObject } from '../storage/schema/Json.ts'
import { Registry } from '../task/Registry.ts'
import * as Task from '../task/Task.ts'
import * as internal from './internal/task.ts'
import type { Declared } from './Tool.ts'

/** The task kind. */
export const name = internal.NAME

/** A model-issued call: the assistant entry that holds it, and its ID there. */
export const Input = Schema.Struct({ assistant: EntryId, callId: Schema.String })
export type Input = typeof Input.Type

export const Checkpoint = Schema.Union([
  Schema.Struct({ phase: Schema.Literal('call') }),
  /** Durable intent: the arguments the call runs with, and the replay policy at that time. */
  Schema.Struct({
    phase: Schema.Literal('execute'),
    arguments: JsonObject,
    replay: Schema.Literals(['safe', 'unsafe']),
  }),
])
export type Checkpoint = typeof Checkpoint.Type

/** The call's result entry. */
export const Result = Schema.Struct({ entryId: EntryId })
export type Result = typeof Result.Type

export type ToolTask = Task.Task<Input, Checkpoint, Result>

/** What `Tx.createTask()` needs to create a call, without the handlers. */
export const kind: TaskKind<Input> = {
  name,
  version: 1,
  initial: () => ({ phase: 'call' }),
}

/** The tool task over the tools of `toolkit` and their `handlers`. */
export const make = <Tools extends Record<string, Declared>>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Context.Context<Tool.HandlersFor<Tools>>,
): ToolTask => Task.make(internal.definition(Object.values(toolkit.tools), handlers))

/** Install the tool task in the `Registry`, over the handlers `toolkit.toLayer()` provides. */
export const layer = <Tools extends Record<string, Declared>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Layer.Layer<never, never, Registry | Tool.HandlersFor<Tools>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const handlers = yield* Effect.context<Tool.HandlersFor<Tools>>()
      const registry = yield* Registry
      yield* registry.install(make(toolkit, handlers))
    }),
  )
