/**
 * Transports between a client and the loop. Both sides take their RPC protocol from context: the
 * loop an `RpcServer.Protocol`, the client an `RpcClient.Protocol`. In one process they share
 * `layerMemory`; split, they use Effect's HTTP or WebSocket protocols instead.
 */
import { Context, Effect, Layer, Queue, Schema } from 'effect'
import type { Scope } from 'effect'
import { RpcClient, RpcServer } from 'effect/rpc'
import type { RpcMessage, RpcSerialization } from 'effect/rpc'

/** Both ends of a transport. */
export type Protocols = RpcServer.Protocol | RpcClient.Protocol

// Messages stay values: holes are lowered to JSON values, never written to strings.
const codecFor: RpcSerialization.CodecFor = Schema.toCodecJson

/** Forward every message of `queue`, in order, through `write`. */
const forward = <A>(
  queue: Queue.Dequeue<readonly [number, A]>,
  write: (clientId: number, message: A) => Effect.Effect<void>,
) =>
  Effect.forkScoped(
    Effect.forever(Effect.flatMap(Queue.take(queue), ([id, message]) => write(id, message))),
  )

/**
 * A server and a client protocol connected in memory. Messages are encoded to JSON values, so the
 * Schemas of every request are checked as they would be across a process, but none is
 * serialized. Each end buffers what arrives before it runs.
 */
export const makeMemory: Effect.Effect<Context.Context<Protocols>, never, Scope.Scope> = Effect.gen(
  function* () {
    const toServer = yield* Queue.unbounded<readonly [number, RpcMessage.FromClientEncoded]>()
    const toClient = yield* Queue.unbounded<readonly [number, RpcMessage.FromServerEncoded]>()
    const disconnects = yield* Queue.unbounded<number>()
    const clientIds = new Set<number>()
    const server = yield* RpcServer.Protocol.make((write) =>
      Effect.as(forward(toServer, write), {
        disconnects,
        send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
          Queue.offer(toClient, [clientId, response]).pipe(Effect.asVoid),
        end: () => Effect.void,
        clientIds: Effect.succeed(clientIds),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: false,
        codecFor,
      }),
    )
    const client = yield* RpcClient.Protocol.make((write) =>
      Effect.as(forward(toClient, write), {
        send: (clientId: number, request: RpcMessage.FromClientEncoded) =>
          Effect.suspend(() => {
            clientIds.add(clientId)
            return Queue.offer(toServer, [clientId, request]).pipe(Effect.asVoid)
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor,
      }),
    )
    return Context.make(RpcServer.Protocol, server).pipe(Context.add(RpcClient.Protocol, client))
  },
)

/** `makeMemory` as a Layer: provide it once to both the loop and its clients. */
export const layerMemory: Layer.Layer<Protocols> = Layer.effectContext(makeMemory)
