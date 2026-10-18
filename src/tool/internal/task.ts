/**
 * The phases of the tool task.
 */
import { Clock, Effect, Exit, Option, Result, Schema } from 'effect'
import type { Context } from 'effect'
import { AssistantMessage } from '../../model/Message.ts'
import type { ToolCall } from '../../model/Message.ts'
import type { Tx } from '../../session/Session.ts'
import { JsonObject } from '../../storage/schema/Json.ts'
import type { Definition, NextState, Runtime } from '../../task/Task.ts'
import type { Any } from '../Tool.ts'
import { CallNotFound } from '../ToolError.ts'
import * as ToolResult from '../ToolResult.ts'
import type { Checkpoint, Input, Result as TaskResult } from '../ToolTask.ts'
import { COMPLETED, execute, install } from './execute.ts'
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

/** In one commit: append the call's result entry and end the task. */
const settleIn = (tx: Tx, runtime: ToolRuntime, call: ToolCall, ran: Ran) =>
  Effect.gen(function* () {
    const timestamp = yield* Clock.currentTimeMillis
    const timing =
      ran.durationMs === undefined ? { timestamp } : { timestamp, durationMs: ran.durationMs }
    const entry = yield* ToolResult.append(tx, runtime.conversationId, call, ran.result, timing)
    return terminal(ran.ending, { entryId: entry.id })
  })

/** Settle with the call read on the line. */
const settle = (runtime: ToolRuntime, input: Input, build: (call: ToolCall) => Ran) =>
  runtime.commit((tx) =>
    Effect.flatMap(readCall(tx, input), (call) => settleIn(tx, runtime, call, build(call))),
  )

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

/** Run the handler on the arguments of intent, then settle. */
const run = (
  runtime: ToolRuntime,
  input: Input,
  call: ToolCall,
  installed: Installed,
  args: JsonObject,
) =>
  Effect.flatMap(execute(call, installed, args), (ran) =>
    runtime.commit((tx) => settleIn(tx, runtime, call, ran)),
  )

const encodeArguments = (tool: Any, params: unknown) =>
  Effect.map(Effect.exit(Schema.encodeUnknownEffect(tool.parameters)(params)), (exit) =>
    Exit.isSuccess(exit) ? Schema.decodeUnknownOption(JsonObject)(exit.value) : Option.none(),
  )

/** Why the call cannot run, or the arguments it runs with, encoded for the checkpoint. */
const prepare = (call: ToolCall, installed: Installed | undefined) =>
  Effect.gen(function* () {
    if (installed === undefined)
      return ToolResult.failure('tool_unavailable', `Tool ${call.name} is not available`)
    const decoded = yield* Effect.result(
      Schema.decodeEffect(installed.tool.parameters)(call.arguments),
    )
    if (Result.isFailure(decoded)) {
      const message = `Invalid arguments for ${call.name}: ${decoded.failure.message}`
      return ToolResult.failure('invalid_arguments', message)
    }
    const args = yield* encodeArguments(installed.tool, decoded.success)
    if (Option.isNone(args))
      return ToolResult.failure(
        'invalid_arguments',
        `Arguments of ${call.name} are not a JSON object`,
      )
    return { args: args.value, installed }
  })

/**
 * The `call` phase: resolve and validate in the intent commit, which settles at once when the
 * call cannot run, then run the handler.
 */
const callPhase =
  (tools: ReadonlyMap<string, Installed>) =>
  (task: { readonly input: Input }, runtime: ToolRuntime) =>
    Effect.gen(function* () {
      let intent:
        | { readonly call: ToolCall; readonly installed: Installed; readonly args: JsonObject }
        | undefined
      yield* runtime.commit((tx) =>
        Effect.gen(function* () {
          const call = yield* readCall(tx, task.input)
          const prepared = yield* prepare(call, tools.get(call.name))
          if (!('args' in prepared))
            return yield* settleIn(tx, runtime, call, { result: prepared, ending: COMPLETED })
          intent = { call, installed: prepared.installed, args: prepared.args }
          const { replay } = prepared.installed.tool
          return {
            status: 'running' as const,
            checkpoint: { phase: 'execute' as const, arguments: prepared.args, replay },
          }
        }),
      )
      if (intent !== undefined)
        yield* run(runtime, task.input, intent.call, intent.installed, intent.args)
    })

/** The `execute` phase, reached only by recovery: rerun only when both policies say `safe`. */
const executePhase =
  (tools: ReadonlyMap<string, Installed>) =>
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
      const installed = tools.get(call.name)
      if (replay === 'safe' && installed?.tool.replay === 'safe')
        return yield* run(runtime, task.input, call, installed, args)
      const message = `Tool ${call.name} was interrupted and may have partially run`
      // `failed` records cancellation intent for what the call owns, now left unsupervised.
      return yield* settle(runtime, task.input, () => ({
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

export const definition = <Services>(
  tools: ReadonlyArray<Any>,
  implementations: Context.Context<Services>,
  config: Readonly<Record<string, unknown>>,
): Definition<Input, Checkpoint, TaskResult> => {
  const byName = install(tools, implementations, config)
  return {
    name: NAME,
    version: 1,
    initial: () => ({ phase: 'call' }),
    phases: { call: callPhase(byName), execute: executePhase(byName) },
    abort: (task, runtime) =>
      settle(runtime, task.input, (call) => {
        const [code, message] = abortCode(task, call.name)
        return { result: ToolResult.failure(code, message), ending: { status: 'aborted' } }
      }),
  }
}
