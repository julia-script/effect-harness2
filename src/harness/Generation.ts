/**
 * The built-in generation task, ported from pi's `GenerationTask` (`harness/generation.ts`): one
 * model request of a run, and the tool round its answer starts.
 *
 * - `prepare` renders the agent's system prompt sections and tool declarations and appends the
 *   positional `pi.system` entries the context needs, then fixes the request: the model, the
 *   request options, and the newest entry it includes.
 * - `request` streams the response. Partials commit to `pi.live.generation`, throttled; a partial
 *   an interruption leaves becomes an aborted `pi.assistant` entry. The response is classified:
 *   a deferred one is polled (`poll`), a `Retryable` failure waits durably (`retry`) and prepares
 *   again, other failures end the run `unanswered` with `model_error`, and an unknown model with
 *   `no_model`.
 * - An answer (`stop`, `length`) ends the run at the final boundary.
 * - Tool calls start a tool round in the commit that appends the answer: each offered call gets a
 *   `pi.tool` task the generation owns, all at once or one after another (`toolExecution`); a call
 *   to a tool the request did not offer is answered `tool_unavailable` at once. `tools` waits for
 *   them, then passes the `postTools` boundary and hands the run to a fresh generation.
 * - Abort answers calls not started yet with `aborted`, cancels a deferred response, and ends the
 *   run `unanswered` with `aborted`.
 *
 * Credentials are the provider's: a provider reads them fresh for each request.
 */
import { Effect, Layer, Schema } from 'effect'
import type { Context } from 'effect'
import { DeferredHandle, ModelThinkingLevel } from '../model/Message.ts'
import * as Model from '../model/Model.ts'
import { EntryId, TaskId } from '../storage/schema/Ids.ts'
import { Registry } from '../task/Registry.ts'
import * as Task from '../task/Task.ts'
import type * as Tool from '../tool/Tool.ts'
import type * as Toolkit from '../tool/Toolkit.ts'
import * as ToolTask from '../tool/ToolTask.ts'
import * as internal from './internal/generation/task.ts'
import type * as prompt from './internal/prompt.ts'
import { RUN_KIND, toolHooks } from './internal/run.ts'
import * as Settings from './Settings.ts'

/** The task kind. */
export const name = RUN_KIND

const attempt = { attempt: Schema.Finite }

export const Checkpoint = Schema.Union([
  Schema.Struct({ phase: Schema.Literal('prepare'), ...attempt }),
  /** The request preparation fixed; a resend after recovery uses it unchanged. */
  Schema.Struct({
    phase: Schema.Literal('request'),
    ...attempt,
    model: Model.Ref,
    options: Model.Options,
    /** The newest entry the request includes. */
    cutoff: EntryId,
  }),
  Schema.Struct({ phase: Schema.Literal('retry'), ...attempt, until: Schema.Finite }),
  Schema.Struct({
    phase: Schema.Literal('poll'),
    ...attempt,
    model: Model.Ref,
    cutoff: EntryId,
    handle: DeferredHandle,
    pollAt: Schema.Finite,
  }),
  /** Waiting on the round's tool tasks, which the generation owns. */
  Schema.Struct({
    phase: Schema.Literal('tools'),
    /** The tool-calling answer. */
    assistant: EntryId,
    /** Tool tasks created so far, in call order. */
    tools: Schema.Array(TaskId),
    /** Calls of a sequential round not started yet, in call order. */
    pending: Schema.Array(Schema.String),
  }),
])
export type Checkpoint = typeof Checkpoint.Type

/** The answer, or the tool-calling answer of a round. */
export const Result = Schema.Struct({ entryId: EntryId })
export type Result = typeof Result.Type

export type Generation = Task.Task<Record<string, never>, Checkpoint, Result>

/** One named part of the system prompt. */
export type Section = prompt.Section
export type SectionInput = prompt.SectionInput

/** What a generation asks with, read as each generation prepares. */
export interface Agent {
  /** Without one, a run ends `unanswered` with `no_model`. */
  readonly model?: Model.Ref
  /** Default `off`. */
  readonly reasoning?: ModelThinkingLevel
  readonly sections?: ReadonlyArray<Section>
  /** The tools the model is offered, in order. */
  readonly tools?: ReadonlyArray<Tool.Any>
}

/**
 * The generation task, over the `Model` in context and `Settings.Current`. It offers the agent's
 * tools; their calls need a tool task, which `tasks` and `layer` install with it.
 */
export const make = (
  agent: Agent | Effect.Effect<Agent>,
): Effect.Effect<Generation, never, Model.Model> =>
  Effect.gen(function* () {
    const model = yield* Model.Model
    const settings = yield* Settings.Current
    const current = Effect.isEffect(agent) ? agent : Effect.succeed(agent)
    return Task.make(internal.definition({ model, settings, agent: current }))
  })

export interface Options<Tools extends Record<string, Tool.Any>> {
  /** An agent without `tools` is offered every tool of the toolkit. */
  readonly agent: Agent | Effect.Effect<Agent>
  readonly config?: ToolTask.Config<Tools>
}

/** The generation task and the tool task over `toolkit` and its `implementations`. */
export const tasks = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  implementations: Context.Context<Toolkit.Implementation<Toolkit.Names<Tools>>>,
  options: Options<Tools>,
): Effect.Effect<ReadonlyArray<Task.Any>, never, Model.Model> =>
  Effect.gen(function* () {
    const offered = Object.values(toolkit.tools)
    const withTools = (agent: Agent): Agent =>
      agent.tools === undefined ? { ...agent, tools: offered } : agent
    const agent = Effect.isEffect(options.agent)
      ? Effect.map(options.agent, withTools)
      : withTools(options.agent)
    const config = options.config === undefined ? {} : { config: options.config }
    return [
      yield* make(agent),
      ToolTask.make(toolkit, implementations, { ...config, hooks: toolHooks }),
    ]
  })

/**
 * Install the generation and tool tasks in the `Registry`, over the `Model` and the handlers
 * `toolkit.toLayer()` provides.
 */
export const layer = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options: Options<Tools>,
): Layer.Layer<
  never,
  never,
  Model.Model | Registry | Toolkit.Implementation<Toolkit.Names<Tools>>
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const implementations = yield* Effect.context<Toolkit.Implementation<Toolkit.Names<Tools>>>()
      const registry = yield* Registry
      for (const task of yield* tasks(toolkit, implementations, options))
        yield* registry.install(task)
    }),
  )
