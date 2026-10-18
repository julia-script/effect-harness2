/**
 * Tools: declarations, the results the model sees, and the built-in tool task that runs a
 * model-issued call durably.
 */

/** Declaration helpers over effect/ai `Tool`: output limits, replay policy, transcript form. */
export * as Tool from './Tool.ts'

/** What a call returns to the model, and its `pi.tool-result` entry. */
export * as ToolResult from './ToolResult.ts'

/** The built-in `pi.tool` task. */
export * as ToolTask from './ToolTask.ts'

/** Errors of the tool task. */
export * as ToolError from './ToolError.ts'
