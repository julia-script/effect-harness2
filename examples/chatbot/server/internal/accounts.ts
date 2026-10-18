/**
 * What the registry does: add an API key account after checking its key, sign in to Codex, list
 * every account's models, and forget an account.
 */
import { Effect, Queue, Stream } from 'effect'
import type { Cause } from 'effect'
import { Anthropic } from 'effect-harness/anthropic'
import { OpenAi, OpenAiCodex } from 'effect-harness/openai'
import { AccountError } from '../../shared/Account.ts'
import type { Account, AddApiKey, Models, Name, SignInEvent } from '../../shared/Account.ts'
import type { Options, Service } from '../Accounts.ts'
import * as providers from './providers.ts'
import * as registry from './registry.ts'
import type { State } from './registry.ts'

/** A provider with the key being added, to check it before it is stored. */
const probe = (input: AddApiKey) => {
  const options = {
    name: input.name,
    apiKey: input.apiKey,
    ...(input.apiUrl === undefined ? {} : { apiUrl: input.apiUrl }),
  }
  return input.kind === 'anthropic' ? Anthropic.provider(options) : OpenAi.provider(options)
}

const addApiKey = (state: State) =>
  Effect.fnUntraced(function* (input: AddApiKey) {
    if ((yield* registry.lookup(state, input.name)) !== undefined) {
      return yield* new AccountError({ message: `${input.name} is already registered` })
    }
    // Check the key: a custom endpoint also tells us what it serves.
    const listed = yield* probe(input).listModels.pipe(
      Effect.provideContext(state.context),
      Effect.mapError(registry.failed('The key did not list any models')),
    )
    const account: Account = {
      kind: input.kind,
      name: input.name,
      label: input.label,
      ...(input.apiUrl === undefined
        ? {}
        : { apiUrl: input.apiUrl, models: listed.map(({ id }) => id) }),
    }
    yield* state.credentials
      .set(input.name, { type: 'api_key', key: input.apiKey })
      .pipe(Effect.mapError(registry.failed('The key could not be stored')))
    yield* registry.register(state, account, () => false)
    return yield* registry.statusOf(state, account)
  })

const signIn = Effect.fnUntraced(function* (
  state: State,
  name: Name,
  label: string,
  queue: Queue.Queue<SignInEvent, AccountError | Cause.Done>,
) {
  const found = yield* registry.lookup(state, name)
  yield* found === undefined || found.kind === 'openai-codex'
    ? Effect.void
    : new AccountError({ message: `${name} is not a Codex account` })
  const authUrl = state.options.codex?.authUrl
  yield* OpenAiCodex.login({
    name,
    ...(authUrl === undefined ? {} : { authUrl }),
    onCode: (code) => Effect.asVoid(Queue.offer(queue, { type: 'code', ...code })),
  }).pipe(
    Effect.provideContext(state.context),
    Effect.mapError(registry.failed('Signing in failed')),
  )
  const account: Account = { kind: 'openai-codex', name, label: found?.label ?? label }
  yield* registry.register(state, account, (existing) => existing.kind === 'openai-codex')
  yield* Queue.offer(queue, { type: 'done', account: yield* registry.statusOf(state, account) })
})

const models = (state: State) =>
  Effect.gen(function* () {
    const all = yield* registry.current(state)
    const found = yield* registry.statuses(
      state,
      all.map(({ account }) => account),
    )
    return yield* Effect.forEach(
      all,
      ({ account, provider }, index) => {
        const status = found[index] ?? { ...account, signedIn: false }
        return provider.listModels.pipe(
          Effect.provideContext(state.context),
          Effect.map((listed): Models => ({ account: status, models: listed })),
          Effect.catch((error) =>
            Effect.succeed<Models>({
              account: status,
              models: providers.served(provider),
              error: error.message,
            }),
          ),
        )
      },
      { concurrency: 'unbounded' },
    )
  })

const remove = (state: State, name: Name) =>
  registry
    .change(state, (all) => Effect.succeed(all.filter(({ account }) => account.name !== name)))
    .pipe(
      Effect.andThen(
        state.credentials
          .remove(name)
          .pipe(Effect.mapError(registry.failed('The credential could not be removed'))),
      ),
    )

export const make = Effect.fnUntraced(function* (options: Options = {}) {
  const state = yield* registry.open(options)
  const service: Service = {
    list: Effect.flatMap(registry.current(state), (all) =>
      registry.statuses(
        state,
        all.map(({ account }) => account),
      ),
    ),
    addApiKey: addApiKey(state),
    signInCodex: (name, label) =>
      Stream.callback<SignInEvent, AccountError>((queue) =>
        signIn(state, name, label, queue).pipe(
          Effect.andThen(Queue.end(queue)),
          Effect.catch((error) => Queue.fail(queue, error)),
        ),
      ),
    remove: (name) => remove(state, name),
    models: models(state),
    providers: Effect.map(registry.current(state), (all) => all.map(({ provider }) => provider)),
  }
  return service
})
