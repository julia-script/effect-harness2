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
 * - `tool_unavailable`: no tool of that name, or no implementation for it.
 * - `invalid_arguments`: the arguments do not decode; `invalid_config`: its config does not.
 * - The tool's declared failure: an error result with the encoded failure; the task completes.
 * - `tool_error`: the handler died, or returned a value its Schema cannot encode; the task ends
 *   `failed`.
 * - `interrupted`: a crash stopped the call after intent and the tool is not replay-safe; on
 *   recovery the `execute` phase answers it instead of running it again. A tool declared with
 *   `replay: 'safe'`, both when intent was recorded and now, runs again.
 * - `aborted`, or on an abandon after restart `interrupted` and `abandoned`: the abort handler.
 *
 * The task needs no services: `make` closes over the implementations, and `layer` installs it in
 * the `Registry` from the implementations a `Toolkit.toLayer()` provides. Config is given at
 * install, encoded; per-conversation config comes with agents.
 */
import { Effect, Layer, Schema } from 'effect'
import type { Context } from 'effect'
import type { TaskKind, Tx } from '../session/Session.ts'
import type { TxDocumentError } from '../session/SessionError.ts'
import { EntryId } from '../storage/schema/Ids.ts'
import type { ConversationId, TaskId } from '../storage/schema/Ids.ts'
import { JsonObject } from '../storage/schema/Json.ts'
import { Registry } from '../task/Registry.ts'
import * as Task from '../task/Task.ts'
import * as internal from './internal/task.ts'
import type * as Tool from './Tool.ts'
import type * as Toolkit from './Toolkit.ts'

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

/** Each tool's config, encoded, by name; a tool left out gets `{}`. */
export type Config<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]?: Tools[Name]['config']['Encoded']
}

/** The tool task of a call, as its hooks see it. */
export interface Call {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
}

/**
 * Run in the tool task's own commits, so the loop can present the call: `started` when the call
 * records intent and its handler is about to run, `settled` with its result entry.
 */
export interface Hooks {
  readonly started?: (tx: Tx, call: Call) => Effect.Effect<void, TxDocumentError>
  readonly settled?: (tx: Tx, call: Call, entry: EntryId) => Effect.Effect<void, TxDocumentError>
}

export interface Options<Tools extends Record<string, Tool.Any>> {
  readonly config?: Config<Tools>
  readonly hooks?: Hooks
}

/** The tool task over the tools of `toolkit` and their `implementations`. */
export const make = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  implementations: Context.Context<Toolkit.Implementation<Toolkit.Names<Tools>>>,
  options: Options<Tools> = {},
): ToolTask =>
  Task.make(
    internal.definition(
      Object.values(toolkit.tools),
      implementations,
      options.config ?? {},
      options.hooks ?? {},
    ),
  )

/** Install the tool task in the `Registry`, over the implementations `toolkit.toLayer()` provides. */
export const layer = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options: Options<Tools> = {},
): Layer.Layer<never, never, Registry | Toolkit.Implementation<Toolkit.Names<Tools>>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const implementations = yield* Effect.context<Toolkit.Implementation<Toolkit.Names<Tools>>>()
      const registry = yield* Registry
      yield* registry.install(make(toolkit, implementations, options))
    }),
  )
