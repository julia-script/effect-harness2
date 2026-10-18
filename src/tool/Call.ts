/**
 * Nested tool calls, ported from pi's `executeTool()`: a running tool's handler calls another tool
 * by name, as a durable tool task of its own that the calling task owns.
 *
 * Each call has a key within its caller, by default the order of the caller's calls in this run.
 * A caller that is replay-safe runs again after a restart and, calling in the same order,
 * reattaches to the calls it made before, so none runs twice unless its own replay policy reruns
 * it. A caller that is not replay-safe never resumes, so its calls are abandoned on a restart.
 * When the caller settles, its calls still running are aborted.
 *
 * A nested call's result is not a transcript entry: it is stored with its caller, in the
 * `pi.tool.nested-call` family, and retires with it.
 */
import { Context, Effect, Schema } from 'effect'
import type { ConversationId, TaskId } from '../storage/schema/Ids.ts'
import type { JsonObject } from '../storage/schema/Json.ts'
import type { RuntimeError } from '../task/Task.ts'
import { NestedCallRefused } from './ToolError.ts'
import { Diagnostic } from './ToolResult.ts'

/**
 * What a nested call came to: its tool's success or declared failure, encoded, as `value`; no
 * `value` when the call could not run, such as for invalid arguments, with error diagnostics
 * saying why. Diagnostics and details are the call's, as a model-issued call's result has them.
 */
export const Outcome = Schema.Struct({
  isError: Schema.Boolean,
  value: Schema.optionalKey(Schema.Json),
  diagnostics: Schema.Array(Diagnostic),
  details: Schema.optionalKey(Schema.Json),
})
export type Outcome = typeof Outcome.Type

export interface Options {
  /** The call's key within its caller: letters, digits, `.`, `_`, `-` and `:`. Default: its order. */
  readonly key?: string
}

export type Failure = NestedCallRefused | RuntimeError

/** The tool call a handler runs for. */
export interface Service {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly callId: string
  /** Call tool `name` with `args`, encoded, and wait for its outcome. */
  readonly execute: (
    name: string,
    args: JsonObject,
    options?: Options,
  ) => Effect.Effect<Outcome, Failure>
}

/** The call a handler runs for, while the tool task runs it; `undefined` elsewhere. */
export const Current: Context.Reference<Service | undefined> = Context.Reference(
  'effect-harness/tool/Call/Current',
  { defaultValue: (): Service | undefined => undefined },
)

/** Call tool `name` from the running handler (see `Service.execute`). */
export const execute = (
  name: string,
  args: JsonObject,
  options?: Options,
): Effect.Effect<Outcome, Failure> =>
  Effect.flatMap(Current, (call) =>
    call === undefined
      ? Effect.fail(new NestedCallRefused({ message: `${name} was called outside a tool call` }))
      : call.execute(name, args, options),
  )
