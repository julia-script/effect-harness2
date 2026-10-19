/* oxlint-disable max-lines-per-function -- describe blocks */
/**
 * The account registry against the stand-in APIs: adding a custom endpoint with a key, signing in
 * to Codex, listing every account's models, chatting with one, and removing it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'
import { Accounts } from 'effect-harness/accounts'
import { Anthropic } from 'effect-harness/anthropic'
import { HarnessClient, HarnessTransport } from 'effect-harness/client'
import { Credentials } from 'effect-harness/credentials'
import { HarnessServer } from 'effect-harness/harness'
import { OpenAi, OpenAiCodex } from 'effect-harness/openai'
import { Storage } from 'effect-harness/storage'
import { adapters } from '../shared/adapters.ts'
import { start } from './upstream.ts'

const upstream = start()
const url = `http://127.0.0.1:${upstream.port}`
afterAll(() => upstream.stop(true))

const Implementations = adapters.toLayer({
  'openai-codex': OpenAiCodex.implementation({ authUrl: url, baseUrl: url }),
  openai: OpenAi.implementation(),
  anthropic: Anthropic.implementation(),
})

const Services = Layer.mergeAll(
  KeyValueStore.layerMemory,
  Credentials.layerMemory(),
  FetchHttpClient.layer,
  Implementations,
)

/** Run `body` with an account registry over the stand-ins, and the stores under it. */
const run = <A, E>(body: Effect.Effect<A, E, Accounts.Accounts | Layer.Success<typeof Services>>) =>
  Effect.runPromise(
    body.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is an entry point
      Effect.provide(Accounts.layer(adapters).pipe(Layer.provideMerge(Services))),
    ),
  )

const custom = {
  adapter: 'openai',
  name: 'local',
  label: 'Local server',
  settings: { apiUrl: `${url}/v1` },
  apiKey: Redacted.make('sk-local'),
}

describe('accounts', () => {
  test('checks a key against the endpoint, and serves what it lists', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        const refused = yield* Effect.flip(
          accounts.add({ ...custom, apiKey: Redacted.make('bad') }),
        )
        expect(refused.message).toContain('The provider refused the account')

        const added = yield* accounts.add(custom)
        expect(added).toMatchObject({ name: 'local', status: 'ready' })
        const [listed] = yield* accounts.models
        expect(listed?.models.map(({ id, served }) => [id, served])).toEqual([
          ['llama-3.3-70b', true],
          ['qwen-3-32b', true],
        ])
        expect(yield* Effect.flip(accounts.add(custom))).toMatchObject({
          message: 'local is already an account',
        })
      }),
    ))

  test('signs in to Codex with a device code, and lists the account models', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        const events = yield* Stream.runCollect(
          accounts.signIn({ adapter: 'openai-codex', name: 'codex-work', label: 'Work' }),
        )
        expect(events.map(({ type }) => type)).toEqual(['code', 'done'])
        expect(events[0]).toMatchObject({ url: `${url}/codex/device` })
        const [listed] = yield* accounts.models
        expect(listed?.models.map(({ id, served }) => [id, served])).toEqual([
          ['gpt-5.5', true],
          ['gpt-next', false],
        ])
      }),
    ))

  test('keeps accounts across a restart, and forgets one with its credential', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        yield* accounts.add(custom)
        yield* Stream.runDrain(
          accounts.signIn({ adapter: 'openai-codex', name: 'codex-home', label: 'Home' }),
        )
        const reopened = yield* Accounts.make(adapters)
        expect((yield* reopened.list).map(({ name }) => name)).toEqual(['local', 'codex-home'])

        yield* reopened.remove('local')
        const store = yield* Credentials.Credentials
        expect(yield* store.get('local')).toBeUndefined()
        expect((yield* reopened.list).map(({ name }) => name)).toEqual(['codex-home'])
      }),
    ))

  test('chats through an account added while the loop runs', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        const App = Layer.merge(
          HarnessServer.layer().pipe(Layer.provide([Accounts.layerModel, Storage.layerMemory])),
          HarnessClient.layer,
        ).pipe(Layer.provide(HarnessTransport.layerMemory))
        yield* Effect.gen(function* () {
          const client = yield* HarnessClient.HarnessClient
          const root = yield* client.root()
          yield* root.configure({ model: { provider: 'local', modelId: 'qwen-3-32b' } })
          const before = yield* (yield* root.submit({ type: 'input', content: 'hi' })).wait
          expect(before).toMatchObject({ status: 'unanswered', reason: 'no_model' })

          yield* accounts.add(custom)
          const after = yield* (yield* root.submit({ type: 'input', content: 'hi' })).wait
          expect(after.status).toBe('done')
          const { items } = yield* root.entries({ order: 'descending' }, 1)
          expect(JSON.stringify(items[0]?.model)).toContain('Custom endpoint: qwen-3-32b here.')
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the chat's own entry point
        }).pipe(Effect.provide(App))
      }),
    ))
})
