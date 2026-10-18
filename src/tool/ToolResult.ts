/**
 * Tool results, ported from pi's `ToolExecutionResult` and `appendToolResult`: what a call
 * returns to the model, and the `pi.tool-result` entry that records it.
 *
 * Diagnostics are remarks about a call for the model and the UI, such as truncation or why a call
 * was refused; they are never part of the tool's own result. The entry's message ends with them
 * rendered, so the stored message is exactly what the model sees, and `data` keeps them as a list.
 */
import { Schema } from 'effect'
import type { Effect } from 'effect'
import type { ToolCall, ToolResultMessage } from '../model/Message.ts'
import type { Tx } from '../session/Session.ts'
import type { TxError } from '../session/SessionError.ts'
import type { EntryRecord } from '../storage/schema/Entry.ts'
import type { ConversationId } from '../storage/schema/Ids.ts'
import type { Content } from './Tool.ts'

/** The entry kind of a tool result. */
export const kind = 'pi.tool-result'

export const Diagnostic = Schema.Struct({
  severity: Schema.Literals(['info', 'warn', 'error']),
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
})
export type Diagnostic = typeof Diagnostic.Type

/** A result entry's `data`. */
export const Data = Schema.Struct({ diagnostics: Schema.Array(Diagnostic) })
export type Data = typeof Data.Type

/** What a call returns to the model. */
export interface Result {
  readonly output: Content
  readonly isError: boolean
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

/** An error diagnostic. */
export const error = (code: string, message: string): Diagnostic => ({
  severity: 'error',
  code,
  message,
})

/** An error result the harness writes itself: no output and one error diagnostic. */
export const failure = (code: string, message: string): Result => ({
  output: [],
  isError: true,
  diagnostics: [error(code, message)],
})

const render = (diagnostics: ReadonlyArray<Diagnostic>) =>
  `<harness>\n${diagnostics.map(({ severity, message }) => `[${severity}] ${message}`).join('\n')}\n</harness>`

/** The message the model sees for `result` of `call`. */
export const message = (
  call: ToolCall,
  result: Result,
  timing: { readonly timestamp: number; readonly durationMs?: number },
): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content:
    result.diagnostics.length === 0
      ? result.output
      : [...result.output, { type: 'text', text: render(result.diagnostics) }],
  isError: result.isError,
  timestamp: timing.timestamp,
  ...(timing.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
})

/** Append the `pi.tool-result` entry of `result`. */
export const append = (
  tx: Tx,
  conversationId: ConversationId,
  call: ToolCall,
  result: Result,
  timing: { readonly timestamp: number; readonly durationMs?: number },
): Effect.Effect<EntryRecord, TxError> =>
  tx.appendEntry(conversationId, {
    kind,
    model: [{ ...message(call, result, timing) }],
    data: { diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })) },
  })
