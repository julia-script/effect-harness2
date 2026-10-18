/* oxlint-disable effecttsgo/any-unknown-in-error-context -- the loop's resolver may fail with anything, and a failure faults the task */
/**
 * The phases of the tool task.
 */
import { Clock, Effect, Exit, Option, Result, Schema } from 'effect'
import { AssistantMessage } from '../../model/Message.ts'
import type { ToolCall } from '../../model/Message.ts'
import type { Tx } from '../../session/Session.ts'
import { JsonObject } from '../../storage/schema/Json.ts'
import * as Hook from '../../task/Hook.ts'
import type { Definition, NextState, Runtime } from '../../task/Task.ts'
import type { Any } from '../Tool.ts'
import { CallNotFound } from '../ToolError.ts'
import * as ToolResult from '../ToolResult.ts'
import type {
  Checkpoint,
  Hooks,
  Input,
  Lifecycle,
  Resolution,
  Resolve,
  Result as TaskResult,
} from '../ToolTask.ts'
import { COMPLETED, execute, rebound } from './execute.ts'
import { afterTool, beforeTool } from './hooks.ts'
import type { Ending, Installed, Ran } from './execute.ts'

type ToolRuntime = Runtime<Input, Checkpoint, TaskResult>

export const NAME = 'pi.tool'

const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage)

/** The call `input` names, read from its assistant entry. */
const readCall = (tx: Tx, input: Input) =>
  Effect.gen(function* () {
    const entry = yield* tx.entry(input.assistant)
    const message = Option.flatMap(Option.fromNullishOr(entry?.model?.[0]), decodeAssistant)
    const call = Option.flatMap(message, ({ content }) =>
      Option.fromNullishOr(
        content.find(
          (block): block is ToolCall => block.type === 'toolCall' && block.id === input.callId,
        ),
      ),
    )
    if (Option.isSome(call)) return call.value
    return yield* new CallNotFound({
      message: `Entry ${input.assistant} has no tool call ${input.callId}`,
      assistant: input.assistant,
      callId: input.callId,
    })
  })

/** The terminal state of `ending`, with the call's result entry as the task's result. */
const terminal = (ending: Ending, result: TaskResult): NextState<Checkpoint, TaskResult> => {
  if (ending.status === 'failed')
    return {
      status: 'terminal',
      outcome: { status: 'failed', error: { message: ending.message }, result },
    }
  return { status: 'terminal', outcome: { status: ending.status, result } }
}

/** The task as its lifecycle sees it. */
const callOf = (runtime: ToolRuntime) => ({
  taskId: runtime.taskId,
  conversationId: runtime.conversationId,
})

/** In one commit: append the call's result entry and end the task. */
const settleIn = (tx: Tx, runtime: ToolRuntime, lifecycle: Lifecycle, call: ToolCall, ran: Ran) =>
  Effect.gen(function* () {
    const timestamp = yield* Clock.currentTimeMillis
    const timing =
      ran.durationMs === undefined ? { timestamp } : { timestamp, durationMs: ran.durationMs }
    const entry = yield* ToolResult.append(tx, runtime.conversationId, call, ran.result, timing)
    if (lifecycle.settled !== undefined) yield* lifecycle.settled(tx, callOf(runtime), entry.id)
    return terminal(ran.ending, { entryId: entry.id })
  })

/** Settle with the call read on the line. */
const settle = (
  runtime: ToolRuntime,
  lifecycle: Lifecycle,
  input: Input,
  build: (call: ToolCall) => Ran,
) =>
  runtime.commit((tx) =>
    Effect.flatMap(readCall(tx, input), (call) =>
      settleIn(tx, runtime, lifecycle, call, build(call)),
    ),
  )

/** Settle at once with `result`: the call never ran. */
const answer = (
  runtime: ToolRuntime,
  lifecycle: Lifecycle,
  input: Input,
  result: ToolResult.Result,
) => settle(runtime, lifecycle, input, () => ({ result, ending: COMPLETED }))

/** The call, read in a commit of its own. */
const currentCall = (runtime: ToolRuntime, input: Input) =>
  Effect.suspend(() => {
    let call: ToolCall | undefined
    return runtime
      .commit((tx) =>
        Effect.map(readCall(tx, input), (read) => {
          call = read
        }),
      )
      .pipe(Effect.flatMap(() => Effect.fromNullishOr(call)))
  })

/** Run the handler on the arguments of intent, ask `afterTool`, then settle. */
const run = (
  runtime: ToolRuntime,
  lifecycle: Lifecycle,
  hooks: ReadonlyArray<Partial<Hooks>>,
  call: ToolCall,
  installed: Installed,
  args: JsonObject,
) =>
  Effect.gen(function* () {
    const ran = yield* execute(call, installed, args)
    const asked = { ...call, arguments: args }
    const result = yield* afterTool(hooks, asked, ran.result, runtime)
    const final = result === ran.result ? ran : { ...ran, result: rebound(installed.tool, result) }
    yield* runtime.commit((tx) => settleIn(tx, runtime, lifecycle, call, final))
  })

const encodeArguments = (tool: Any, params: unknown) =>
  Effect.map(Effect.exit(Schema.encodeUnknownEffect(tool.parameters)(params)), (exit) =>
    Exit.isSuccess(exit) ? Schema.decodeUnknownOption(JsonObject)(exit.value) : Option.none(),
  )

/** Why the call cannot run on `args`, or the arguments it runs with, encoded for the checkpoint. */
const prepare = (call: ToolCall, installed: Installed | undefined, args: JsonObject) =>
  Effect.gen(function* () {
    if (installed === undefined)
      return ToolResult.failure('tool_unavailable', `Tool ${call.name} is not available`)
    const decoded = yield* Effect.result(Schema.decodeEffect(installed.tool.parameters)(args))
    if (Result.isFailure(decoded)) {
      const message = `Invalid arguments for ${call.name}: ${decoded.failure.message}`
      return ToolResult.failure('invalid_arguments', message)
    }
    const encoded = yield* encodeArguments(installed.tool, decoded.success)
    if (Option.isNone(encoded))
      return ToolResult.failure(
        'invalid_arguments',
        `Arguments of ${call.name} are not a JSON object`,
      )
    return { args: encoded.value, installed }
  })

/** Validate, ask `beforeTool`, and validate what it leaves: the call runs, or its answer. */
const admit = (call: ToolCall, resolution: Resolution, api: Hook.Api) =>
  Effect.gen(function* () {
    const installed = resolution.tool(call.name)
    const checked = yield* prepare(call, installed, call.arguments)
    if (!('args' in checked)) return checked
    const decided = yield* beforeTool(resolution.hooks, { ...call, arguments: checked.args }, api)
    if ('block' in decided)
      return ToolResult.failure('blocked', `Tool call blocked: ${decided.block}`)
    return decided.args === checked.args ? checked : yield* prepare(call, installed, decided.args)
  })

/**
 * The `call` phase: resolve, validate, and ask `beforeTool`, settling at once when the call
 * cannot run; then record intent and run the handler.
 */
const callPhase =
  (resolve: Resolve, lifecycle: Lifecycle) =>
  (task: { readonly input: Input }, runtime: ToolRuntime) =>
    Effect.gen(function* () {
      const call = yield* currentCall(runtime, task.input)
      const resolution = yield* resolve(runtime)
      const admitted = yield* admit(call, resolution, runtime)
      if (!('args' in admitted)) return yield* answer(runtime, lifecycle, task.input, admitted)
      const { installed, args } = admitted
      yield* runtime.commit((tx) =>
        Effect.gen(function* () {
          if (lifecycle.started !== undefined) yield* lifecycle.started(tx, callOf(runtime))
          return {
            status: 'running' as const,
            checkpoint: {
              phase: 'execute' as const,
              arguments: args,
              replay: installed.tool.replay,
            },
          }
        }),
      )
      return yield* run(runtime, lifecycle, resolution.hooks, call, installed, args)
    })

/** The `execute` phase, reached only by recovery: rerun only when both policies say `safe`. */
const executePhase =
  (resolve: Resolve, lifecycle: Lifecycle) =>
  (
    task: {
      readonly input: Input
      readonly state: { readonly checkpoint: Extract<Checkpoint, { phase: 'execute' }> }
    },
    runtime: ToolRuntime,
  ) =>
    Effect.gen(function* () {
      const { arguments: args, replay } = task.state.checkpoint
      const call = yield* currentCall(runtime, task.input)
      const resolution = yield* resolve(runtime)
      const installed = resolution.tool(call.name)
      if (replay === 'safe' && installed?.tool.replay === 'safe')
        return yield* run(runtime, lifecycle, resolution.hooks, call, installed, args)
      const message = `Tool ${call.name} was interrupted and may have partially run`
      // `failed` records cancellation intent for what the call owns, now left unsupervised.
      return yield* settle(runtime, lifecycle, task.input, () => ({
        result: ToolResult.failure('interrupted', message),
        ending: { status: 'failed', message },
      }))
    })

/** Why the call was aborted: on an abandon after a restart, whether it may have run. */
const abortCode = (
  task: { readonly abortReason?: 'restart'; readonly state: { readonly checkpoint: Checkpoint } },
  name: string,
): readonly [string, string] => {
  if (task.abortReason !== 'restart') return ['aborted', `Tool ${name} was aborted`]
  if (task.state.checkpoint.phase === 'execute')
    return ['interrupted', `Tool ${name} was interrupted by a restart and may have partially run`]
  return ['abandoned', `Tool ${name} was not started: its caller ended with a restart`]
}

export const definition = (
  resolve: Resolve,
  lifecycle: Lifecycle,
): Definition<Input, Checkpoint, TaskResult> => ({
  name: NAME,
  version: 1,
  initial: () => ({ phase: 'call' }),
  phases: { call: callPhase(resolve, lifecycle), execute: executePhase(resolve, lifecycle) },
  abort: (task, runtime) =>
    settle(runtime, lifecycle, task.input, (call) => {
      const [code, message] = abortCode(task, call.name)
      return { result: ToolResult.failure(code, message), ending: { status: 'aborted' } }
    }),
})
