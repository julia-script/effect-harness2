/**
 * `AccountsRpcs` served from the `Accounts` in context, over the `RpcServer.Protocol` in context.
 */
import { Effect, Layer } from 'effect'
import { RpcServer } from 'effect/rpc'
import { AccountsRpcs } from '../shared/AccountsRpcs.ts'
import { Accounts } from './Accounts.ts'

const handlers = AccountsRpcs.toLayer(
  Effect.map(Accounts, (accounts) =>
    AccountsRpcs.of({
      List: () => accounts.list,
      AddApiKey: (input) => accounts.addApiKey(input),
      SignInCodex: ({ name, label }) => accounts.signInCodex(name, label),
      Remove: ({ name }) => accounts.remove(name),
      Models: () => accounts.models,
    }),
  ),
)

export const layer: Layer.Layer<never, never, Accounts | RpcServer.Protocol> = RpcServer.layer(
  AccountsRpcs,
).pipe(Layer.provide(handlers))
