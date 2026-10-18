/**
 * Stand-ins for the provider APIs the chatbot talks to, on one local server: an OpenAI-compatible
 * endpoint at `/v1`, and ChatGPT's device sign-in and Codex backend at the root. Answers stream a
 * few words at a time, naming the model that answered.
 *
 *   bun examples/chatbot/test/upstream.ts   # prints its URL
 *
 * A key is good when it starts with `sk-`. A device sign-in is approved on its second poll.
 */

import { Option, Schema } from 'effect'

const jwt = (account: string) =>
  [
    btoa(JSON.stringify({ alg: 'none' })),
    btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })),
    'signature',
  ]
    .join('.')
    .replaceAll('=', '')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const response = (model: string, status: string, output: ReadonlyArray<unknown>) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model,
  status,
  output,
  metadata: null,
  temperature: null,
  top_p: null,
  tools: [],
  tool_choice: 'auto',
  error: null,
  incomplete_details: null,
  instructions: null,
  parallel_tool_calls: false,
  ...(status === 'completed'
    ? {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }
    : {}),
})

const message = (status: string, text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status,
  content: text === '' ? [] : [{ type: 'output_text', text, annotations: [] }],
})

/** The events of a Responses API answer of `text`, a word per delta. */
const events = (model: string, text: string) => {
  const words = text.split(/(?<= )/u)
  return [
    { type: 'response.created', response: response(model, 'in_progress', []) },
    { type: 'response.output_item.added', output_index: 0, item: message('in_progress', '') },
    ...words.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    })),
    { type: 'response.output_item.done', output_index: 0, item: message('completed', text) },
    {
      type: 'response.completed',
      response: response(model, 'completed', [message('completed', text)]),
    },
  ].map((event, index) => Object.assign(event, { sequence_number: index + 1 }))
}

const encoder = new TextEncoder()

/** Server-sent `events`, one every 60 ms. */
const stream = (all: ReadonlyArray<unknown>) => {
  let next = 0
  return new Response(
    new ReadableStream({
      pull: async (controller) => {
        await Bun.sleep(60)
        const event = all[next]
        next += 1
        if (event === undefined) controller.close()
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const Body = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        role: Schema.optionalKey(Schema.String),
        content: Schema.optionalKey(
          Schema.Union([
            Schema.String,
            Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
          ]),
        ),
      }),
    ),
  ),
})
type Body = typeof Body.Type
const decodeBody = Schema.decodeUnknownOption(Body)

const DeviceToken = Schema.Struct({ device_auth_id: Schema.String })
const decodeDevice = Schema.decodeUnknownOption(DeviceToken)

/** The text of the last user message of a Responses request. */
const lastUser = (body: Body) => {
  const content = (body.input ?? []).toReversed().find((item) => item.role === 'user')?.content
  if (content === undefined || typeof content === 'string') return content ?? ''
  return content.map((part) => part.text ?? '').join('')
}

const answer = async (request: Request, prefix: string) => {
  const body = Option.getOrElse(decodeBody(await request.json()), (): Body => ({}))
  const model = body.model ?? 'unknown'
  return stream(events(model, `${prefix} ${model} here. You said: ${lastUser(body)}`))
}

const codexModels = {
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Frontier model',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'xhigh', description: 'Deepest' },
      ],
      visibility: 'list',
      priority: 1,
      service_tiers: [{ id: 'priority', name: 'Fast', description: 'Faster, at more usage' }],
    },
    {
      slug: 'gpt-next',
      display_name: 'GPT Next',
      description: 'Not in the catalog yet',
      visibility: 'list',
      priority: 2,
    },
  ],
}

const polls = new Map<string, number>()
let devices = 0

const route = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const key = request.headers.get('authorization')?.replace('Bearer ', '') ?? ''
  if (url.pathname === '/v1/models') {
    return key.startsWith('sk-')
      ? json({ data: [{ id: 'llama-3.3-70b' }, { id: 'qwen-3-32b' }] })
      : json({ error: { message: 'Incorrect API key' } }, 401)
  }
  if (url.pathname === '/v1/responses') return answer(request, 'Custom endpoint:')
  if (url.pathname === '/api/accounts/deviceauth/usercode') {
    devices += 1
    return json({
      device_auth_id: `dev_${devices}`,
      user_code: `CODE-${devices}000`,
      interval: '1',
    })
  }
  if (url.pathname === '/api/accounts/deviceauth/token') {
    const id = Option.match(decodeDevice(await request.json()), {
      onNone: () => '',
      onSome: (body) => body.device_auth_id,
    })
    const seen = polls.get(id) ?? 0
    polls.set(id, seen + 1)
    return seen === 0
      ? json({ error: 'pending' }, 403)
      : json({ authorization_code: `code_${id}`, code_verifier: 'verifier' })
  }
  if (url.pathname === '/oauth/token') {
    return json({
      access_token: jwt(`acct_${devices}`),
      refresh_token: 'refresh',
      expires_in: 3600,
    })
  }
  if (url.pathname === '/codex/models') return json(codexModels)
  if (url.pathname === '/codex/responses') return answer(request, 'Codex')
  return json({ error: 'not found' }, 404)
}

/** Serve the stand-ins on `port`, 0 for any. */
export const start = (port = 0) => Bun.serve({ hostname: '127.0.0.1', port, fetch: route })

if (import.meta.main) {
  const server = start(Number(process.env['PORT'] ?? 0))
  console.log(`http://127.0.0.1:${server.port}`)
}
