/**
 * Test support: a Harness loop launched over a memory transport, its client, and the scripted
 * stand-in for the generation task.
 */
import { Effect, Layer, Queue } from 'effect'
import type { Scope } from 'effect'
import { HarnessServer } from '../../harness/index.ts'
import type { Step } from '../../harness/test/support.ts'
import { standIn } from '../../harness/test/support.ts'
import * as Settings from '../../harness/Settings.ts'
import type { Service as StorageService } from '../../storage/Storage.ts'
import { Storage } from '../../storage/Storage.ts'
import { Registry } from '../../task/index.ts'
import { HarnessClient, HarnessTransport } from '../index.ts'

export interface Opened {
  readonly client: HarnessClient.Service
  readonly answer: (text: string) => Effect.Effect<void>
}

/** Launch a loop over `storage` and a memory transport in the scope, and connect a client. */
export const open = (
  storage: StorageService,
  options: HarnessServer.Options = {},
): Effect.Effect<Opened, never, Scope.Scope> =>
  Effect.gen(function* () {
    const steps = yield* Queue.unbounded<Step>()
    const settings = Effect.succeed(Settings.defaults)
    const loop = HarnessServer.layerWith(options).pipe(
      Layer.provide(Layer.succeed(Storage, storage)),
      Layer.provide(Registry.layer([standIn(steps, settings)])),
    )
    const transport = yield* HarnessTransport.makeMemory
    yield* Layer.launch(loop).pipe(
      Effect.provideContext(transport),
      Effect.orDie,
      Effect.forkScoped,
    )
    const client = yield* Effect.provideContext(HarnessClient.make, transport)
    return {
      client,
      answer: (text) => Effect.asVoid(Queue.offer(steps, { kind: 'answer', text })),
    }
  })

export { runTest } from '../../task/test/support.ts'
