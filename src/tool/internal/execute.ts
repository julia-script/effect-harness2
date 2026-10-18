/* oxlint-disable effecttsgo/any-unknown-in-error-context -- a handler may fail with anything; fromExit decides what each failure means */
/**
 * Running one call's handler, and turning what it returns into the result the model sees.
 */
import { Cause, Clock, Context, Effect, Exit, Option, Schema } from 'effect'
import { AiError } from 'effect/ai'
import type { Tool } from 'effect/ai'
import type { ToolCall } from '../../model/Message.ts'
import type { JsonObject } from '../../storage/schema/Json.ts'
import type { Content, Declared } from '../Tool.ts'
import { outputLimits } from '../Tool.ts'
import * as ToolResult from '../ToolResult.ts'
import { boundContent } from './bound.ts'

/** A tool and the handler a `Toolkit.toLayer()` provided for it, if any. */
export interface Runner {
  readonly tool: Declared
  readonly handler: Option.Option<Tool.Handler<string>>
}

/** The runner of each tool in `tools`, by name. */
export const runners = <Services>(
  tools: ReadonlyArray<Declared>,
  handlers: Context.Context<Services>,
): ReadonlyMap<string, Runner> =>
  new Map(
    tools.map((tool) => [
      tool.name,
      {
        tool,
        // effect/ai keys each tool's handler by the tool's ID.
        handler: Context.getOption(handlers, Context.Service<Tool.Handler<string>>(tool.id)),
      },
    ]),
  )

/**
 * How a call ends besides its result: `failed` when the tool broke (the handler died or its value
 * did not encode), which records cancellation intent for what the call owns.
 */
export type Ending =
  | { readonly status: 'completed' | 'aborted' }
  | { readonly status: 'failed'; readonly message: string }

export const COMPLETED: Ending = { status: 'completed' }

/** What a run produced. */
export interface Ran {
  readonly result: ToolResult.Result
  readonly ending: Ending
  readonly durationMs?: number
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A broken tool: a `tool_error` result, and the task ends `failed`. */
const broken = (call: ToolCall, message: string): Omit<Ran, 'durationMs'> => ({
  result: ToolResult.failure('tool_error', message),
  ending: { status: 'failed', message: `Tool ${call.name} failed` },
})

/** An encoded value as model content: a string as itself, anything else as JSON. */
const contentOf = (encoded: unknown): Content => {
  const text = typeof encoded === 'string' ? encoded : JSON.stringify(encoded ?? null)
  return text === '' ? [] : [{ type: 'text', text }]
}

/** `output` within the tool's limits, with a `truncated` warning when they dropped text. */
const bounded = (tool: Declared, output: Content, isError: boolean): ToolResult.Result => {
  const limits = outputLimits(tool)
  const { content, droppedBytes, droppedLines } = boundContent(output, limits)
  if (droppedBytes === 0) return { output: content, isError, diagnostics: [] }
  const kept = limits.retain === 'head' ? 'beginning' : 'end'
  const message = `Output truncated to its ${kept}: ${droppedLines} lines, ${droppedBytes} bytes dropped`
  return {
    output: content,
    isError,
    diagnostics: [{ severity: 'warn', code: 'truncated', message }],
  }
}

/** The result of a handler's success or declared failure, encoded by the tool's Schema. */
const encoded = (call: ToolCall, tool: Declared, value: unknown, isFailure: boolean) => {
  const schema = isFailure ? tool.failureSchema : tool.successSchema
  return Effect.match(Schema.encodeUnknownEffect(schema)(value), {
    onFailure: (error) =>
      broken(call, `Tool ${call.name} returned a value its Schema rejects: ${error.message}`),
    onSuccess: (encodedValue) => ({
      result: bounded(tool, contentOf(encodedValue), isFailure),
      ending: COMPLETED,
    }),
  })
}

/** What the handler's exit means for the call. Interruption is not caught: it stops the task. */
const fromExit = (call: ToolCall, tool: Declared, exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return encoded(call, tool, exit.value, false)
  const { cause } = exit
  if (Cause.hasInterrupts(cause)) return Effect.interrupt
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) return Effect.succeed(broken(call, Cause.pretty(cause)))
  const error = failure.value
  if (AiError.isAiError(error) || AiError.isAiErrorReason(error))
    return Effect.succeed(broken(call, errorText(error)))
  return encoded(call, tool, error, true)
}

/** Decode `args` and run the handler on them. */
export const execute = (call: ToolCall, runner: Runner, args: JsonObject) =>
  Effect.gen(function* () {
    const { tool, handler } = runner
    if (Option.isNone(handler)) {
      const message = `Tool ${call.name} has no implementation`
      return { result: ToolResult.failure('tool_unavailable', message), ending: COMPLETED }
    }
    const params = yield* Effect.exit(Schema.decodeEffect(tool.parametersSchema)(args))
    if (Exit.isFailure(params)) {
      const message = `Arguments of ${call.name} no longer decode: ${Cause.pretty(params.cause)}`
      return { result: ToolResult.failure('invalid_arguments', message), ending: COMPLETED }
    }
    const started = yield* Clock.currentTimeMillis
    const run: Effect.Effect<unknown, unknown> = handler.value.handler(params.value, {
      toolCallId: call.id,
      preliminary: () => Effect.void,
    })
    const exit = yield* Effect.exit(
      run.pipe(
        Effect.updateContext((input: Context.Context<never>) =>
          Context.merge(handler.value.context, input),
        ),
      ),
    )
    const durationMs = (yield* Clock.currentTimeMillis) - started
    const ran = yield* fromExit(call, tool, exit)
    return { ...ran, durationMs }
  })
