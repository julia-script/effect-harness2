/**
 * The accounts a person registers in the chatbot, as Schemas the browser and the server share.
 * One account is one model provider: its kind, the name requests route by (which is also the key
 * its credential is stored under), and where it points. Secrets never come back to the browser.
 */
import { Schema } from 'effect'
import { Credential } from 'effect-harness/credentials'
import { Model } from 'effect-harness/model'

/** The name requests route by and the credential is stored under: `codex-work`, `openrouter`. */
export const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u))
export type Name = typeof Name.Type

/** `openai` takes any OpenAI-compatible Responses API, at `apiUrl`. */
export const Kind = Schema.Literals(['openai', 'openai-codex', 'anthropic'])
export type Kind = typeof Kind.Type

/** A registered account, as the server keeps it. */
export const Account = Schema.Struct({
  kind: Kind,
  name: Name,
  label: Schema.String,
  /** A custom endpoint; absent, the provider's own. */
  apiUrl: Schema.optionalKey(Schema.String),
  /**
   * The models a custom endpoint serves, as it listed them when the account was added. Absent, the
   * provider's catalog.
   */
  models: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Account = typeof Account.Type

/** An account and whether its credential is stored. */
export const Status = Schema.Struct({ ...Account.fields, signedIn: Schema.Boolean })
export type Status = typeof Status.Type

/** Register an account that takes an API key. */
export const AddApiKey = Schema.Struct({
  kind: Schema.Literals(['openai', 'anthropic']),
  name: Name,
  label: Schema.String,
  apiUrl: Schema.optionalKey(Schema.String),
  apiKey: Credential.Secret,
})
export type AddApiKey = typeof AddApiKey.Type

/** What a Codex sign-in streams: the code to enter, then the account once approved. */
export const SignInEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('code'), url: Schema.String, code: Schema.String }),
  Schema.Struct({ type: Schema.Literal('done'), account: Status }),
])
export type SignInEvent = typeof SignInEvent.Type

/** One account's models now, or why they could not be listed and what it serves anyway. */
export const Models = Schema.Struct({
  account: Status,
  models: Schema.Array(Model.Listed),
  /** Listing failed; `models` are the ones it serves from its catalog. */
  error: Schema.optionalKey(Schema.String),
})
export type Models = typeof Models.Type

export class AccountError extends Schema.TaggedError<
  AccountError,
  { readonly brand: unique symbol }
>('chatbot/Account/AccountError')('AccountError', { message: Schema.String }) {}
