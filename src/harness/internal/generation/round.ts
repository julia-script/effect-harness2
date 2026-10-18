/**
 * The tool round (spec §8.5): the tool tasks of one tool-calling answer, owned by its generation.
 */
import { Clock, Effect, Option, Schema } from 'effect'
import { AssistantMessage } from '../../../model/Message.ts'
import type { ToolCall } from '../../../model/Message.ts'
import * as Transcript from '../../../model/Transcript.ts'
import type { Tx } from '../../../session/Session.ts'
import type { EntryId, TaskId } from '../../../storage/schema/Ids.ts'
import * as ToolResult from '../../../tool/ToolResult.ts'
import * as ToolTask from '../../../tool/ToolTask.ts'
import * as Live from '../../Live.ts'
import { prepareBoundary } from '../inbox.ts'
import { appendAssistant, continueRun } from '../run.ts'
import type { Request } from './classify.ts'
import { readView } from './env.ts'
import type { Env, GenerationRuntime, Next } from './env.ts'

/** A tool task for call `callId`, owned by the generation. */
const createToolTask = (tx: Tx, runtime: GenerationRuntime, assistant: EntryId, callId: string) =>
  tx.createTask(
    ToolTask.kind,
    { assistant, callId },
    { ownership: { kind: 'task', taskId: runtime.taskId } },
  )

/** What a round starts with: each call's slot, the tasks created now, and the calls left. */
interface Round {
  readonly slots: Array<Live.ToolSlot>
  readonly tools: Array<TaskId>
  readonly pending: Array<string>
}

/** Answer, start, or hold one call of a round being started. */
const startCall = Effect.fnUntraced(function* (
  tx: Tx,
  runtime: GenerationRuntime,
  round: Round,
  assistant: EntryId,
  call: ToolCall,
  start: { readonly offered: boolean; readonly hold: boolean; readonly timestamp: number },
) {
  const slot = { callId: call.id, name: call.name }
  if (!start.offered) {
    const unavailable = ToolResult.failure('tool_unavailable', `Tool ${call.name} is not available`)
    const result = yield* ToolResult.append(tx, runtime.conversationId, call, unavailable, {
      timestamp: start.timestamp,
    })
    round.slots.push({ ...slot, status: 'done', entry: result.id })
    return
  }
  if (start.hold) {
    round.pending.push(call.id)
    round.slots.push({ ...slot, status: 'pending' })
    return
  }
  const taskId = yield* createToolTask(tx, runtime, assistant, call.id)
  round.tools.push(taskId)
  round.slots.push({ ...slot, taskId, status: 'pending' })
})

/**
 * Append the tool-calling answer and start its round in one commit. A call to a tool the request
 * did not offer is answered `tool_unavailable` here; every other call gets a tool task, only the
 * first one now when the round is sequential. The generation keeps the run and waits in `tools`.
 */
export const startToolRound = (
  runtime: GenerationRuntime,
  env: Env,
  request: Request,
  message: AssistantMessage,
  calls: ReadonlyArray<ToolCall>,
) =>
  Effect.gen(function* () {
    const messages = request.messages ?? (yield* readView(runtime, request.cutoff)).messages
    const offered = new Set(Transcript.tools(messages).map((tool) => tool.name))
    const sequential = (yield* env.settings).toolExecution === 'sequential'
    const timestamp = yield* Clock.currentTimeMillis
    yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(Live.document, runtime.conversationId)
        const entry = yield* appendAssistant(tx, runtime.conversationId, message)
        const round: Round = { slots: [], tools: [], pending: [] }
        for (const call of calls) {
          const start = {
            offered: offered.has(call.name),
            hold: sequential && round.tools.length > 0,
            timestamp,
          }
          yield* startCall(tx, runtime, round, entry.id, call, start)
        }
        delete live.generation
        live.tools = round.slots
        const { tools, pending } = round
        const checkpoint = { phase: 'tools', assistant: entry.id, tools, pending } as const
        // A round whose every call was answered here has nothing to wait for.
        const next: Next =
          tools.length === 0
            ? { status: 'running', checkpoint }
            : { status: 'waiting', checkpoint, on: tools, policy: 'allSettled' }
        return next
      }),
    )
  })

/**
 * The round's tasks are terminal: pass the `postTools` boundary and hand the run to the next
 * generation, or, for a queued reset, end it.
 */
const finishToolRound = (runtime: GenerationRuntime, env: Env, assistant: EntryId) =>
  runtime.commit((tx) =>
    Effect.gen(function* () {
      const boundary = yield* prepareBoundary(tx, runtime.conversationId, yield* env.settings)
      yield* continueRun(tx, boundary, runtime.taskId)
      const next: Next = {
        status: 'terminal',
        outcome: { status: 'completed', result: { entryId: assistant } },
      }
      return next
    }),
  )

type ToolsCheckpoint = {
  readonly phase: 'tools'
  readonly assistant: EntryId
  readonly tools: ReadonlyArray<TaskId>
  readonly pending: ReadonlyArray<string>
}

/** The `tools` phase: start the next call of a sequential round, or finish the round. */
export const toolsPhase =
  (env: Env) =>
  (
    task: { readonly state: { readonly checkpoint: ToolsCheckpoint } },
    runtime: GenerationRuntime,
  ) =>
    Effect.gen(function* () {
      const { assistant, tools, pending } = task.state.checkpoint
      const [next, ...rest] = pending
      if (next === undefined) return yield* finishToolRound(runtime, env, assistant)
      return yield* runtime.commit((tx) =>
        Effect.gen(function* () {
          const live = yield* tx.doc(Live.document, runtime.conversationId)
          const taskId = yield* createToolTask(tx, runtime, assistant, next)
          const slot = live.tools?.find((each) => each.callId === next && each.taskId === undefined)
          if (slot !== undefined) slot.taskId = taskId
          const state: Next = {
            status: 'waiting',
            checkpoint: { phase: 'tools', assistant, tools: [...tools, taskId], pending: rest },
            on: [taskId],
            policy: 'allSettled',
          }
          return state
        }),
      )
    })

const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage)

/** The calls `callIds` of the assistant entry, in the given order, read before any write. */
export const readCalls = (tx: Tx, assistant: EntryId, callIds: ReadonlyArray<string>) =>
  Effect.map(tx.entry(assistant), (entry) => {
    const message = Option.flatMap(Option.fromNullishOr(entry?.model?.[0]), decodeAssistant)
    const calls = Option.match(message, { onNone: () => [], onSome: Transcript.toolCalls })
    return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1))
  })
