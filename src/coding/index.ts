/**
 * Stock coding tools: `read`, `write`, `edit` and `bash`, ported from pi's `tools/`.
 */

/** The tool declarations and their extension; importable by the client. */
export * as CodingTools from './CodingTools.ts'

/** Their implementations over `FileSystem`, `Path` and `ChildProcessSpawner`. */
export * as CodingHandlers from './CodingHandlers.ts'
