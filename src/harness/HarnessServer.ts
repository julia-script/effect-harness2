/**
 * The loop serving its clients: `HarnessRpcs` on the `Harness`, over the `RpcServer.Protocol` in
 * context. Run it with `Layer.launch`; clients reach it through the matching transport.
 */
import { Layer } from 'effect'
import { RpcServer } from 'effect/rpc'
import type { Session } from '../session/Session.ts'
import type { CommitError } from '../session/SessionError.ts'
import type { Storage } from '../storage/Storage.ts'
import type { Registry } from '../task/Registry.ts'
import type { Scheduler } from '../task/Scheduler.ts'
import { HarnessRpcs } from '../client/HarnessRpcs.ts'
import * as Harness from './Harness.ts'
import type { Initializer } from './Initializer.ts'
import { handlers } from './internal/server.ts'

export interface ServeOptions {
  /** The named inits clients may call. */
  readonly initializers?: ReadonlyArray<Initializer>
}

export interface Options extends Harness.Options, ServeOptions {}

/** Serve the `Harness` in context. */
export const layer = (
  options: ServeOptions = {},
): Layer.Layer<never, never, Harness.Harness | RpcServer.Protocol> =>
  RpcServer.layer(HarnessRpcs).pipe(Layer.provide(handlers(options.initializers ?? [])))

/** Open a Harness over the Storage and Registry, and serve it. */
export const layerWith = (
  options: Options = {},
): Layer.Layer<
  Harness.Harness | Session | Scheduler,
  CommitError,
  Storage | Registry | RpcServer.Protocol
> => layer(options).pipe(Layer.provideMerge(Harness.layerWith(options)))
