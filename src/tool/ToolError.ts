/**
 * Errors of the tool task.
 */
import { Schema } from 'effect'
import { EntryId } from '../storage/schema/Ids.ts'

/** No call `callId` in the assistant entry: the task's input is broken, so the task faults. */
export class CallNotFound extends Schema.TaggedError<
  CallNotFound,
  { readonly brand: unique symbol }
>('effect-harness/tool/ToolError/CallNotFound')('CallNotFound', {
  message: Schema.String,
  assistant: EntryId,
  callId: Schema.String,
}) {}
