/**
 * Tool declarations. A declaration is an effect/ai `Tool` made with `Tool.make`: its name,
 * description, and the Schemas of its parameters, success and failure. It imports nothing that
 * runs, so the client and the loop can both import it. The implementation is a
 * `Toolkit.toLayer()` handler, provided only where the loop runs.
 *
 * Annotations add what the tool task needs to know: whether a call interrupted by a crash may run
 * again (effect/ai's `Tool.Idempotent`) and how much of its output the model sees
 * (`OutputLimits`).
 */
import { Context, Option, Schema } from 'effect'
import { Tool } from 'effect/ai'
import { JsonObject } from '../storage/schema/Json.ts'
import type { ImageContent, TextContent, ToolDefinition } from '../model/Message.ts'

type Codec = Schema.ConstraintCodec<unknown>

/**
 * A tool the tool task can run: its Schemas need no services to decode or encode, so a call's
 * arguments and result cross storage on their own.
 */
export type Declared = Tool.Any &
  Tool.Tool<
    string,
    {
      readonly parameters: Codec
      readonly success: Codec
      readonly failure: Codec
      readonly failureMode: Tool.FailureMode
    }
  >

/** What the model sees of a result. */
export type Content = ReadonlyArray<TextContent | ImageContent>

/** How much of a result the model sees: whole lines, from the start (`head`) or the end. */
export interface OutputLimits {
  readonly maxBytes: number
  readonly maxLines: number
  readonly retain: 'head' | 'tail'
}

/** pi's defaults: 50 KB or 2,000 lines, from the start. */
export const defaultOutputLimits: OutputLimits = {
  maxBytes: 50 * 1024,
  maxLines: 2000,
  retain: 'head',
}

/** Annotation: the tool's output limits. */
export const OutputLimits = Context.Reference<OutputLimits>(
  'effect-harness/tool/Tool/OutputLimits',
  { defaultValue: () => defaultOutputLimits },
)

/** The tool's output limits. */
export const outputLimits = (tool: Tool.Any): OutputLimits =>
  Context.get(tool.annotations, OutputLimits)

/**
 * Whether a call a crash interrupted after it started may run again: the tool is annotated
 * `Tool.Idempotent`. Otherwise the call ends as interrupted, since it may have partly run.
 */
export const isReplaySafe = (tool: Tool.Any): boolean =>
  Context.get(tool.annotations, Tool.Idempotent)

const parametersOf = Schema.decodeUnknownOption(JsonObject)

/** The tool as the transcript offers it to the model, with its parameters as JSON Schema. */
export const definition = (tool: Tool.Any): ToolDefinition => {
  const parameters = parametersOf(Tool.getJsonSchema(tool))
  return {
    name: String(tool.name),
    description: tool.description ?? '',
    parameters: Option.getOrElse(parameters, () => ({ type: 'object' })),
  }
}
