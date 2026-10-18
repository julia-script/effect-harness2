/**
 * The chatbot's account registry, on the server: the accounts people add and remove while it runs,
 * each one a model provider. It keeps the accounts in a `KeyValueStore`, their secrets in
 * `Credentials`, and the providers in memory, which `Model.layerDynamic` routes to.
 */
import { Context, Effect, Layer } from 'effect'
import type { Stream } from 'effect'
import type { HttpClient } from 'effect/http'
import type { KeyValueStore } from 'effect/persistence'
import { Credentials } from 'effect-harness/credentials'
import { Model } from 'effect-harness/model'
import type {
  AccountError,
  AddApiKey,
  Models,
  Name,
  SignInEvent,
  Status,
} from '../shared/Account.ts'
import * as internal from './internal/accounts.ts'

/** What the providers of the accounts need to answer. */
export type Requires = HttpClient.HttpClient | Credentials.Credentials

export interface Service {
  readonly list: Effect.Effect<ReadonlyArray<Status>, AccountError>
  readonly addApiKey: (input: AddApiKey) => Effect.Effect<Status, AccountError>
  readonly signInCodex: (name: Name, label: string) => Stream.Stream<SignInEvent, AccountError>
  readonly remove: (name: Name) => Effect.Effect<void, AccountError>
  readonly models: Effect.Effect<ReadonlyArray<Models>, AccountError>
  /** The providers of the accounts registered now. */
  readonly providers: Effect.Effect<ReadonlyArray<Model.Provider<Requires>>>
}

export class Accounts extends Context.Service<Accounts, Service>()('chatbot/server/Accounts') {}

export interface Options {
  /** Where Codex accounts sign in and send requests; the defaults are ChatGPT's. */
  readonly codex?: { readonly authUrl?: string; readonly baseUrl?: string }
}

export const make: (
  options?: Options,
) => Effect.Effect<
  Service,
  AccountError,
  KeyValueStore.KeyValueStore | HttpClient.HttpClient | Credentials.Credentials
> = internal.make

export const layer = (options: Options = {}) => Layer.effect(Accounts, make(options))

/** A `Model` over the accounts' providers, as they are at each request. */
export const layerModel: Layer.Layer<Model.Model, never, Accounts | Requires> = Layer.unwrap(
  Effect.map(Accounts, (accounts) => Model.layerDynamic(accounts.providers)),
)
