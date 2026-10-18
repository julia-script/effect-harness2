/**
 * The generation task: its phases and abort handler.
 */
import { Clock, Effect } from 'effect'
import * as Tool from '../../../tool/Tool.ts'
import * as ToolResult from '../../../tool/ToolResult.ts'
import type { Definition, RunningTask } from '../../../task/Task.ts'
import type { Checkpoint, Result } from '../../Generation.ts'
import { EmptyConversation } from '../../GenerationError.ts'
import * as Live from '../../Live.ts'
import { planSystemEntries, renderSections, replaySections } from '../prompt.ts'
import { convertPartial, endRun, RUN_KIND } from '../run.ts'
import { failNoModel } from './classify.ts'
import { readView, sleepUntil } from './env.ts'
import type { Env, GenerationRuntime, Next } from './env.ts'
import { pollPhase, requestPhase } from './request.ts'
import { readCalls, toolsPhase } from './round.ts'

type Phase<P extends Checkpoint['phase']> = {
  readonly state: { readonly checkpoint: Extract<Checkpoint, { readonly phase: P }> }
}

/**
 * The `prepare` phase: render the system prompt and tool declarations, append the `pi.system`
 * entries they need, and fix the request. Only the Harness writes model context to a busy
 * conversation, so the context read here is still current at the commit.
 */
const preparePhase = (env: Env) => (task: Phase<'prepare'>, runtime: GenerationRuntime) =>
  Effect.gen(function* () {
    const { conversationId } = runtime
    const { attempt } = task.state.checkpoint
    const agent = yield* env.agent
    const ref = agent.model
    if (ref === undefined || env.model.info(ref) === undefined)
      return yield* failNoModel(runtime, ref)
    const view = yield* readView(runtime)
    const shown = replaySections(view.messages)
    const desired = yield* renderSections(agent.sections ?? [], conversationId, shown)
    const tools = (agent.tools ?? []).map((tool) => Tool.definition(tool))
    const entries = planSystemEntries(view, desired, tools, yield* Clock.currentTimeMillis)
    const { stream } = yield* env.settings
    const reasoning = agent.reasoning ?? 'off'
    const options = reasoning === 'off' ? stream : { ...stream, reasoning }
    return yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        let cutoff = (yield* tx.scanEntries({ conversationId }, 1)).items[0]?.id
        for (const entry of entries) cutoff = (yield* tx.appendEntry(conversationId, entry)).id
        if (cutoff === undefined)
          return yield* new EmptyConversation({
            message: `Conversation ${conversationId} has no entries to send`,
            conversationId,
          })
        const next: Next = {
          status: 'running',
          checkpoint: { phase: 'request', attempt, model: ref, options, cutoff },
        }
        return next
      }),
    )
  })

/** The `retry` phase: wait out the backoff, then prepare the next attempt. */
const retryPhase = (task: Phase<'retry'>, runtime: GenerationRuntime) =>
  Effect.gen(function* () {
    const { attempt, until } = task.state.checkpoint
    yield* sleepUntil(until)
    yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(Live.document, runtime.conversationId)
        live.generation = { attempt: attempt + 1 }
        const next: Next = {
          status: 'running',
          checkpoint: { phase: 'prepare', attempt: attempt + 1 },
        }
        return next
      }),
    )
  })

/**
 * Abort: cancel a deferred response, answer the calls of the round not started yet `aborted`,
 * keep a partial as an aborted entry, and end the run `unanswered` with `aborted`. It runs after
 * the round's tool tasks, which the generation owns, are terminal.
 */
const abort =
  (env: Env) =>
  (task: RunningTask<Record<string, never>, Checkpoint>, runtime: GenerationRuntime) =>
    Effect.gen(function* () {
      const { checkpoint } = task.state
      if (checkpoint.phase === 'poll')
        yield* Effect.ignore(env.model.cancel(checkpoint.model, checkpoint.handle))
      const { conversationId } = runtime
      const timestamp = yield* Clock.currentTimeMillis
      yield* runtime.commit((tx) =>
        Effect.gen(function* () {
          const unstarted =
            checkpoint.phase === 'tools'
              ? yield* readCalls(tx, checkpoint.assistant, checkpoint.pending)
              : []
          const live = yield* tx.doc(Live.document, conversationId)
          yield* convertPartial(tx, live, conversationId)
          for (const call of unstarted) {
            const aborted = ToolResult.failure('aborted', `Tool ${call.name} was aborted`)
            yield* ToolResult.append(tx, conversationId, call, aborted, { timestamp })
          }
          yield* endRun(tx, live, runtime.taskId, { status: 'unanswered', reason: 'aborted' })
          const next: Next = { status: 'terminal', outcome: { status: 'aborted' } }
          return next
        }),
      )
    })

export const definition = (env: Env): Definition<Record<string, never>, Checkpoint, Result> => ({
  name: RUN_KIND,
  version: 1,
  initial: () => ({ phase: 'prepare', attempt: 1 }),
  phases: {
    prepare: preparePhase(env),
    request: requestPhase(env),
    retry: retryPhase,
    poll: pollPhase(env),
    tools: toolsPhase(env),
  },
  abort: abort(env),
})
