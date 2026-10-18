/**
 * The accounts protocol: what the browser asks the server about providers. It sits next to
 * `HarnessRpcs` on its own socket.
 */
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AccountError, AddApiKey, Models, Name, SignInEvent, Status } from './Account.ts'

export class AccountsRpcs extends RpcGroup.make(
  Rpc.make('List', { success: Schema.Array(Status), error: AccountError }),
  /** Check the key by listing models with it, then store it and register the account. */
  Rpc.make('AddApiKey', { payload: AddApiKey, success: Status, error: AccountError }),
  /** Sign in to ChatGPT with a device code; signing in to an existing Codex account renews it. */
  Rpc.make('SignInCodex', {
    payload: { name: Name, label: Schema.String },
    success: SignInEvent,
    error: AccountError,
    stream: true,
  }),
  /** Forget the account and its credential. */
  Rpc.make('Remove', { payload: { name: Name }, error: AccountError }),
  /** Every account's models, listed live over its own credential. */
  Rpc.make('Models', { success: Schema.Array(Models), error: AccountError }),
) {}
