/**
 * Test support: a Harness running the built-in generation and tool tasks over the `Faux` model
 * and the scripted tools of `tool/test/support.ts`.
 */
import { Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import { Faux, Model } from '../../model/index.ts'
import type { Service as StorageService } from '../../storage/Storage.ts'
import { Storage } from '../../storage/Storage.ts'
import type { EntryRecord } from '../../storage/schema/Entry.ts'
import { Registry } from '../../task/index.ts'
import type { Script } from '../../tool/test/support.ts'
import { script, slowHandlers, toolkit } from '../../tool/test/support.ts'
import * as Generation from '../Generation.ts'
import * as Harness from '../Harness.ts'
import * as Settings from '../Settings.ts'
import type { Settled } from '../Submission.ts'

export interface Opened {
  readonly harness: Harness.Service
  readonly faux: Faux.Faux
  readonly script: Script
}

export interface Options {
  /** Default: the faux model with every tool of the toolkit. */
  readonly agent?: (faux: Faux.Faux) => Generation.Agent | Effect.Effect<Generation.Agent>
  readonly settings?: Settings.Input
  readonly faux?: Faux.Options
}

/** Open a Harness over `storage` in the scope, with the built-in tasks installed. */
export const open = (
  storage: StorageService,
  options: Options = {},
): Effect.Effect<Opened, never, Scope.Scope> =>
  Effect.gen(function* () {
    const faux = yield* Faux.make(options.faux)
    const current = yield* script
    const settings = Settings.make({
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
      ...options.settings,
    })
    const implementations = yield* Layer.build(toolkit.toLayer(slowHandlers(current)))
    const agent = options.agent?.(faux) ?? { model: faux.ref() }
    const tasks = yield* Generation.tasks(toolkit, implementations, { agent }).pipe(
      Effect.provideService(Model.Model, Model.make([faux.provider])),
      Effect.provideService(Settings.Current, settings),
    )
    const harness = yield* Harness.make.pipe(
      Effect.provideService(Storage, storage),
      Effect.provideService(Registry.Registry, yield* Registry.make(tasks)),
      Effect.provideService(Settings.Current, settings),
    )
    const opened: Opened = { harness, faux, script: current }
    return opened
  }).pipe(Effect.orDie)

/** The first model message of an entry. */
export const messageOf = (entry: EntryRecord): Record<string, unknown> => entry.model?.[0] ?? {}

/** Every entry of the conversation, oldest first. */
export const entriesOf = (
  harness: Harness.Service,
  conversationId: EntryRecord['conversationId'],
) =>
  Effect.orDie(
    Effect.flatMap(harness.conversation(conversationId), (conversation) =>
      conversation === undefined
        ? Effect.succeed([])
        : Effect.map(conversation.entries({ order: 'ascending' }, 1000), (page) => page.items),
    ),
  )

/** Each entry as `kind`, with the text or tool calls of its message. */
export const describe = (entry: EntryRecord): string => {
  const message = entry.model?.[0]
  const content: unknown = message?.['content']
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }]
  const parts = blocks.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return []
    if ('text' in block && typeof block.text === 'string' && block.text !== '') return [block.text]
    if ('name' in block && typeof block.name === 'string') return [`call ${block.name}`]
    return []
  })
  const stop = message?.['stopReason']
  const suffix = typeof stop === 'string' && stop !== 'stop' ? ` (${stop})` : ''
  return `${entry.kind}${parts.length > 0 ? `: ${parts.join(' | ')}` : ''}${suffix}`
}

/** The settled submission, unanswered or done. */
export const reasonOf = (settled: Settled): string =>
  settled.status === 'unanswered' ? settled.reason : settled.status

export { eventually, liveOf, ownerless, runTest } from './support.ts'
