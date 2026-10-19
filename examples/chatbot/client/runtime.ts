/**
 * The browser's services: the harness client and the accounts client, each over its own WebSocket
 * to the server that served the page.
 */
import { Context, Effect, Layer, ManagedRuntime, Predicate } from 'effect'
import { RpcClient } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import { HarnessClient, HarnessTransport } from 'effect-harness/client'
import { AccountsRpcs } from 'effect-harness/accounts'

const socket = (path: string) =>
  HarnessTransport.layerWebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`,
  )

export class AccountsClient extends Context.Service<
  AccountsClient,
  RpcClient.FromGroup<typeof AccountsRpcs.AccountsRpcs, RpcClientError>
>()('chatbot/client/AccountsClient') {}

const Accounts = Layer.effect(AccountsClient, RpcClient.make(AccountsRpcs.AccountsRpcs)).pipe(
  Layer.provide(socket('/accounts')),
)

const Harness = HarnessClient.layer.pipe(Layer.provide(socket('/harness')))

export const runtime = ManagedRuntime.make(Layer.mergeAll(Accounts, Harness))
export type Services = AccountsClient | HarnessClient.HarnessClient

const messageOf = (error: unknown): string =>
  Predicate.hasProperty(error, 'message') && Predicate.isString(error.message)
    ? error.message
    : String(error)

/** Run `effect` in the background, reporting a failure to `onError`. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, Services>,
  onError: (message: string) => void,
): void => {
  runtime.runFork(
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          onError(messageOf(error))
        }),
      ),
    ),
  )
}
