/**
 * The OpenAI provider against a local stand-in for the Responses API: the request it sends for the
 * catalog model and options, and the response it maps back.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { Credentials } from '../../credentials/index.ts'
import { Model } from '../../model/index.ts'
import type { Message } from '../../model/index.ts'
import { serve } from '../../model/test/fakeApi.ts'
import { OpenAi } from '../index.ts'

const response = (status: string) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: 'gpt-5',
  status,
  output: [],
  metadata: null,
  temperature: null,
  top_p: null,
  tools: [],
  tool_choice: 'auto',
  error: null,
  incomplete_details: null,
  instructions: null,
  parallel_tool_calls: false,
})

const message = (status: string, text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status,
  content: text === '' ? [] : [{ type: 'output_text', text, annotations: [] }],
})

const events = [
  { type: 'response.created', sequence_number: 1, response: response('in_progress') },
  {
    type: 'response.output_item.added',
    sequence_number: 2,
    output_index: 0,
    item: message('in_progress', ''),
  },
  {
    type: 'response.output_text.delta',
    sequence_number: 3,
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'Hello',
    logprobs: [],
  },
  {
    type: 'response.output_item.done',
    sequence_number: 4,
    output_index: 0,
    item: message('completed', 'Hello'),
  },
  {
    type: 'response.completed',
    sequence_number: 5,
    response: {
      ...response('completed'),
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  },
]

const user = (text: string): Message.Message => ({ role: 'user', content: text, timestamp: 0 })

/** Ask `modelId` through a Model over `provider`, with `options`. */
const ask = <R>(provider: Model.Provider<R>, modelId: string, options: Model.Options = {}) =>
  Effect.gen(function* () {
    const model = yield* Model.make([provider])
    const info = model.info(OpenAi.ref(modelId))
    if (info === undefined) return yield* Effect.die(`no ${modelId}`)
    const request = { model: OpenAi.ref(modelId), messages: [user('hi')], options }
    return yield* Model.collect(model.stream(request), info)
  })

describe('OpenAi.provider', () => {
  test('sends the catalog model, its effort and the key, and maps the response', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* serve(() => events)
          const provider = OpenAi.provider({
            apiKey: Redacted.make('sk-given'),
            apiUrl: `${api.url}/v1`,
          })
          const answer = yield* ask(provider, 'gpt-5.5', { reasoning: 'minimal', maxTokens: 500 })
          expect(answer).toMatchObject({
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
            provider: 'openai',
            model: 'gpt-5.5',
            stopReason: 'stop',
          })
          expect(api.requests).toHaveLength(1)
          expect(api.requests[0]).toMatchObject({
            path: '/v1/responses',
            headers: { authorization: 'Bearer sk-given' },
            // gpt-5.5 has no `minimal`: the nearest effort it has, rising, is `low`.
            body: { model: 'gpt-5.5', max_output_tokens: 500, reasoning: { effort: 'low' } },
          })
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is an entry point
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ))

  test('without a key, reads the stored one for each request', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* serve(() => events)
          const provider = OpenAi.provider({ apiUrl: `${api.url}/v1` })
          const store = yield* Credentials.Credentials
          yield* store.set('openai', { type: 'api_key', key: Redacted.make('sk-first') })
          yield* ask(provider, 'gpt-5')
          yield* store.set('openai', { type: 'api_key', key: Redacted.make('sk-second') })
          yield* ask(provider, 'gpt-5')
          expect(api.requests.map((request) => request.headers['authorization'])).toEqual([
            'Bearer sk-first',
            'Bearer sk-second',
          ])
        }),
      ).pipe(Effect.provide([FetchHttpClient.layer, Credentials.layerMemory()]), Effect.orDie),
    ))
})
