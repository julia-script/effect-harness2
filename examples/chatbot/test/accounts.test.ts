/* oxlint-disable max-lines-per-function -- describe blocks */
/**
 * The account registry against the stand-in APIs: adding a custom endpoint with a key, signing in
 * to Codex, listing every account's models, chatting with one, and removing it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'
import { HarnessClient, HarnessTransport } from 'effect-harness/client'
import { Credentials } from 'effect-harness/credentials'
import { HarnessServer } from 'effect-harness/harness'
import { Storage } from 'effect-harness/storage'
import * as Accounts from '../server/Accounts.ts'
import { start } from './upstream.ts'

const upstream = start()
const url = `http://127.0.0.1:${upstream.port}`
afterAll(() => upstream.stop(true))

const Services = Layer.mergeAll(
  KeyValueStore.layerMemory,
  Credentials.layerMemory(),
  FetchHttpClient.layer,
)

/** Run `body` with an account registry over the stand-ins, and the stores under it. */
const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Accounts.Accounts | Credentials.Credentials | KeyValueStore.KeyValueStore | Accounts.Requires
  >,
) =>
  Effect.runPromise(
    body.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is an entry point
      Effect.provide(
        Accounts.layer({ codex: { authUrl: url, baseUrl: url } }).pipe(
          Layer.provideMerge(Services),
        ),
      ),
    ),
  )

const custom = {
  kind: 'openai' as const,
  name: 'local',
  label: 'Local server',
  apiUrl: `${url}/v1`,
  apiKey: Redacted.make('sk-local'),
}

describe('accounts', () => {
  test('checks a key against the endpoint, and serves what it lists', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        const refused = yield* Effect.flip(
          accounts.addApiKey({ ...custom, apiKey: Redacted.make('bad') }),
        )
        expect(refused.message).toContain('The key did not list any models')

        const added = yield* accounts.addApiKey(custom)
        expect(added).toMatchObject({ name: 'local', signedIn: true })
        expect(added.models).toEqual(['llama-3.3-70b', 'qwen-3-32b'])
        const [listed] = yield* accounts.models
        expect(listed?.models.map(({ id, served }) => [id, served])).toEqual([
          ['llama-3.3-70b', true],
          ['qwen-3-32b', true],
        ])
        expect(yield* Effect.flip(accounts.addApiKey(custom))).toMatchObject({
          message: 'local is already registered',
        })
      }),
    ))

  test('signs in to Codex with a device code, and lists the account models', () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts
        const events = yield* Stream.runCollect(accounts.signInCodex('codex-work', 'Work'))
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
        yield* accounts.addApiKey(custom)
        yield* Stream.runDrain(accounts.signInCodex('codex-home', 'Home'))
        const reopened = yield* Accounts.make({ codex: { authUrl: url, baseUrl: url } })
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

          yield* accounts.addApiKey(custom)
          const after = yield* (yield* root.submit({ type: 'input', content: 'hi' })).wait
          expect(after.status).toBe('done')
          const { items } = yield* root.entries({ order: 'descending' }, 1)
          expect(JSON.stringify(items[0]?.model)).toContain('Custom endpoint: qwen-3-32b here.')
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the chat's own entry point
        }).pipe(Effect.provide(App))
      }),
    ))
})
