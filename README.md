# effect-harness

A durable agent harness, written in [Effect](https://effect.website).

Every turn, model request and tool call is a task with a checkpoint in storage. Kill the process
in the middle of a tool round, start it again, and the conversation picks up where it stopped.
Safe tool calls run again, unsafe ones end as interrupted, and the model is told.

It's a port of [pi](https://github.com/julia-script/pi)'s `packages/durable`, reworked to fit
Effect: services and layers, Schemas at every boundary, typed errors, and nothing that throws.

```
client ──transport──▶ loop ──▶ Session ──▶ Storage
                       │                    memory · JSONL · SQLite · Postgres
                       ├─ Scheduler (durable tasks)
                       ├─ Model ──▶ providers (effect/ai, Faux)
                       └─ Extensions ──▶ tools, sections, hooks
```

- **Durable.** Conversations, documents and tasks live in one commit log. Each change is one
  atomic commit.
- **Built for a split.** The client only knows request schemas. Run it in the same process, a
  browser, or another machine, and change nothing but the transport.
- **Your tools.** Declare a tool as Schemas and implement it as a layer. It runs as its own
  durable task, can call other tools, and can stay hidden until `tool_search` loads it.
- **Batteries.** Compaction, retries, usage tracking, live views, coding tools
  (`read`/`write`/`edit`/`bash`) and code mode.

## Contents

- [Quickstart](#quickstart)
- [Talking to a conversation](#talking-to-a-conversation)
- [Watching](#watching)
- [Tools](#tools)
- [Models](#models)
- [Accounts](#accounts)
- [Credentials](#credentials)
- [Storage](#storage)
- [Splitting the client and the loop](#splitting-the-client-and-the-loop)
- [Deploying to Cloudflare](#deploying-to-cloudflare)
- [Under the harness](#under-the-harness)
- [Entry points](#entry-points)
- [How it differs from pi](#how-it-differs-from-pi)
- [Development](#development)

## Quickstart

A loop and a client in one process, with the scripted `Faux` model and the coding tools.

```ts
import { BunServices } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'
import { HarnessClient, HarnessTransport } from 'effect-harness/client'
import { CodingHandlers, CodingTools } from 'effect-harness/coding'
import { HarnessServer } from 'effect-harness/harness'
import { Faux, Model } from 'effect-harness/model'
import { Storage } from 'effect-harness/storage'

const main = Effect.gen(function* () {
  const faux = yield* Faux.make()
  yield* faux.setResponses([
    Faux.message(Faux.toolCall('bash', { command: 'ls' }), { stopReason: 'toolUse' }),
    Faux.message('Two files.'),
  ])

  // The loop, with the coding tools. It needs storage, a model and the tools' handlers.
  const Loop = HarnessServer.layer({
    extensions: [CodingTools.extension],
    settings: { model: faux.ref() },
  }).pipe(Layer.provide([CodingHandlers.layer, Model.layer([faux.provider]), Storage.layerMemory]))

  // One memory transport, shared by the loop and its client.
  const App = Layer.merge(Loop, HarnessClient.layer).pipe(
    Layer.provide(HarnessTransport.layerMemory),
  )

  const chat = Effect.gen(function* () {
    const client = yield* HarnessClient.HarnessClient
    const root = yield* client.root()

    const submission = yield* root.submit({ type: 'input', content: 'What is here?' })
    yield* submission.wait // { status: 'done', ... }

    const { items } = yield* root.entries({ order: 'ascending' }, 50)
    // pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant
  })

  yield* chat.pipe(Effect.provide(App))
})

main.pipe(Effect.provide(BunServices.layer), Effect.runPromise)
```

`BunServices.layer` gives the coding tools a file system, paths and a process spawner. To make
it durable, swap `Storage.layerMemory` for a [store on disk](#storage). To use a real model, swap
`faux` for a [provider](#models).

`read` sends images as they are when they fit. Add an `ImageProcessor` layer to turn photos
upright, shrink large images, and convert BMP: `BunImageProcessor.layer` from
`effect-harness/coding/bun` uses `Bun.Image`, `SharpImageProcessor.layer` from
`effect-harness/coding/sharp` uses `sharp` (an optional peer dependency), and
`ImageProcessor.layer(codec)` takes any other library.

`HarnessServer.layer` builds the task registry, the extension registry and the built-in
generation, tool and compaction tasks itself. Its options override the pieces:

- `extensions`: installed before the loop opens. Their tools' handlers become requirements of
  the layer, so a missing handler is a type error.
- `settings`: the run settings; without it, `Settings.layer` from outside, or the defaults.
- `tasks`: more task definitions, replacing a built-in one of the same name.
- `initializers`, `conversationCreated`, `documentRetention`: as before.

`Harness.layer` takes the same options without serving RPCs, and `HarnessServer.layerRpcs`
serves a `Harness` you built yourself.

## Talking to a conversation

`client.root()` gets the reserved root conversation. You can also create, fork and look up
others. A handle is just an ID, so it survives restarts.

```ts
const root = yield * client.root()

yield *
  root.configure({
    model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
    reasoning: 'high',
    instructions: 'Be brief.',
    extensions: { add: ['coding-tools'] },
  })
yield * root.agent
// { tools: ['read', 'write', 'edit', 'bash'], ... }
```

Submissions queue while the conversation is busy, unless you ask them not to:

```ts
const sub = yield * root.submit({ type: 'input', content: 'next?' })
yield * root.submit({ type: 'input', content: 'now!', whenBusy: 'reject' })
// fails with ConversationBusy

// After a restart, find it again by ID.
const again = yield * client.submission(sub.id)
yield * again!.wait
```

Everything else is on the handle too:

```ts
yield * root.fork(entryId, { ownership: { kind: 'ownerless' } })
yield * root.compact('Keep the API decisions.')
yield * root.reset('Handoff: we picked SQLite.')
yield * root.abort() // stop live work
yield * root.waitForIdle
```

### Named inits

A client can ask the loop to seed a new conversation in the same commit that creates it. The
client declares the `Init`, and the loop implements it.

```ts
// shared
const Seed = Init.make('seed', Schema.Struct({ text: Schema.String }))

// loop
const seed = Initializer.make(Seed, (tx, id, { text }) =>
  Effect.asVoid(tx.appendEntry(id, { kind: 'note', data: { text } })),
)
HarnessServer.layer({ initializers: [seed] })

// client
yield * client.root({ init: Init.call(Seed, { text: 'hello' }) })
```

## Watching

Views and events are scoped streams. Each starts from a snapshot, and after that only changes
cross the transport.

```ts
yield *
  Effect.scoped(
    Effect.gen(function* () {
      const view = yield* root.view
      view.value.entries // committed now

      const events = yield* root.events
      yield* events.batches.pipe(
        Stream.flattenIterable,
        Stream.runForEach((event) =>
          event.type === 'message_update' ? Effect.log(event.changes) : Effect.void,
        ),
      )
    }),
  )
```

Events follow pi's agent events: `run_start`, `message_update`, `tool_execution_end`,
`compaction_start`, `usage_changed` and the rest. `client.taskGraph` watches every live task.

Over a WebSocket, a watch survives a dropped connection or a restarted loop: the client opens it
again, and its next change is the loop's state then, or a fresh `snapshot` among the events.

## Tools

A tool's declaration is plain data: Schemas for its parameters, result, failure and config. You
can import it anywhere, including the client. Its implementation lives in the loop.

```ts
import { Tool, Toolkit } from 'effect-harness/tool'
import { Extension } from 'effect-harness/harness'

const Weather = Tool.make('weather', {
  description: 'Current weather for a city.',
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ celsius: Schema.Number }),
  failure: Schema.String,
  replay: 'safe', // run it again after a crash
})

const toolkit = Toolkit.make(Weather)
export const weather = Extension.make('weather', { toolkit })
```

Implement it with `toolkit.toLayer`, and install the extension with the loop:

```ts
const WeatherLive = toolkit.toLayer({
  weather: ({ city }) =>
    city === 'Atlantis' ? Effect.fail('No such city') : Effect.succeed({ celsius: 21 }),
})

const Loop = HarnessServer.layer({ extensions: [weather] }).pipe(Layer.provide(WeatherLive))
```

`Extensions.layerInstall(weather)` installs one into a running loop instead, which is how
extension code reloads.

A conversation picks extensions by name, with `configure({ extensions })` or
`Settings.extensions`. An extension can also carry system prompt `sections`, `hooks`, `wraps`
around other extensions' tools, and its own `tasks`.

A handler can call other tools. Each call is its own durable task:

```ts
const Trip = Tool.make('trip', {
  description: 'Plan a trip.',
  parameters: Schema.Struct({ cities: Schema.Array(Schema.String) }),
  success: Schema.Array(Schema.Json),
})

const TripLive = Toolkit.make(Trip).toLayer({
  trip: ({ cities }) =>
    Effect.forEach(cities, (city) =>
      Call.execute('weather', { city }).pipe(
        Effect.map((outcome) => outcome.value ?? null),
        Effect.orDie,
      ),
    ),
})
```

Mark a tool `deferred: true` to keep it out of the prompt until the model finds it. Install
`ToolSearch.extension` with `ToolSearch.layer` to give the model `tool_search`.

### Stock tools

```ts
HarnessServer.layer({
  // read, write, edit, bash over FileSystem, Path and ChildProcessSpawner
  // code mode: the model writes a script that calls your tools
  extensions: [CodingTools.extension, Codemode.extension()],
}).pipe(
  Layer.provide([CodingHandlers.layer, CodemodeHandlers.layer()]),
  Layer.provide(CodemodeHandlers.layerSandbox()),
)
```

Code mode runs on `@earendil-works/pi-codemode`. Every call a script makes is journaled, so a
script that crashes halfway replays without running its calls twice.

## Models

The `Model` service sends each request to a provider by name. Responses stream as deltas and
end with a `done` event.

A provider is a plain value. `effect-harness/openai` and `effect-harness/anthropic` ship API-key
and subscription providers over `@effect/ai-openai` and `@effect/ai-anthropic` (optional peer dependencies; install the
one you use). Their model lists come from pi-ai's catalog, with context windows, costs and how
each model takes reasoning.

```ts
import { Anthropic } from 'effect-harness/anthropic'
import { OpenAi } from 'effect-harness/openai'

const Loop = HarnessServer.layer({
  extensions: [CodingTools.extension],
  settings: { model: OpenAi.ref('gpt-5.5') },
}).pipe(
  Layer.provide([
    CodingHandlers.layer,
    Model.layer([
      OpenAi.provider({ apiKey: Redacted.make('sk-...') }), // a fixed key
      Anthropic.provider(), // the `anthropic` key from Credentials, read for each request
    ]),
    Storage.layerMemory,
  ]),
  Layer.provide([FetchHttpClient.layer, Credentials.layerConfig()]),
)
```

`Model.layer` needs what its providers need: an `HttpClient` for both, and `Credentials` for a
provider without a key. `apiUrl` points one at a compatible server or a gateway, and `models`
replaces its model list.

Codex runs on a ChatGPT subscription. Sign in once from the client, which stores the tokens in
`Credentials`; the provider refreshes them before they expire, so the store must be writable:

```ts
// client, once
yield * OpenAiCodex.login({ onCode: ({ url, code }) => Console.log(`Open ${url}, enter ${code}`) })

// loop
Model.layer([OpenAiCodex.provider()]) // settings: { model: OpenAiCodex.ref('gpt-5.5') }
```

Each provider holds one account, named by `name`, which is also what its requests route by and
its credential is stored under. For several accounts, give each provider its own name:

```ts
yield * OpenAiCodex.login({ name: 'codex-work', onCode })

Model.layer([
  OpenAiCodex.provider({ name: 'codex-work' }),
  OpenAiCodex.provider({ name: 'codex-home' }),
  OpenAi.provider({ name: 'openai-team' }), // reads the `openai-team` API key
]) // settings: { model: OpenAiCodex.ref('gpt-5.5', 'codex-work') }
```

A stock provider also lists what its account reaches, over the same credentials: each model with
the thinking levels it takes and, for Codex, its default level and service tiers. `served` says
whether the provider routes requests to it.

```ts
const codex = OpenAiCodex.provider({ name: 'codex-work' })
const listed = yield * codex.listModels // needs HttpClient and Credentials, like the provider
// [{ id: 'gpt-5.5', thinkingLevels: ['low', 'medium', 'xhigh'], serviceTiers: [...], served: true }, ...]
```

Claude Pro/Max subscriptions are available explicitly through `AnthropicOAuth`; ordinary API keys
continue to use `Anthropic`. This is a browser PKCE authorization flow, **not a device code**.
The host opens the authorization URL, then supplies the returned `code#state` or full callback
URL. Bare codes, mismatched states, duplicate callback parameters, and expired attempts are rejected:

```ts
import { AnthropicOAuth } from 'effect-harness/anthropic'

// `completion` is your host's Effect<string> from a prompt or authenticated UI.
yield *
  AnthropicOAuth.login({
    name: 'claude-work',
    onAuthorize: (url) => Console.log(`Open ${url}`),
    completion,
  })

Model.layer([AnthropicOAuth.provider({ name: 'claude-work' })])
// model: AnthropicOAuth.ref('claude-sonnet-5-5', 'claude-work'), reasoning: 'high'
```

For a browser application, `begin({ name })` returns a private authorization context and URL;
retain that context on the server, then call `complete(context, callback)` after the person
submits the callback. A CLI with a host-owned loopback listener can pass
`redirectUri: 'http://localhost:53692/callback'` to `begin` or `login`. The library does not open
browsers or bind ports. Attempts expire after ten minutes; `login` also bounds the whole flow
with an optional `timeout`. Never log the authorization context or callback: Claude requires
its PKCE verifier as the state, and the authorization URL therefore contains sensitive state.

Provide `HttpClient` and a **writable, persistent** `Credentials` store to both login and the
provider. `Credentials.layerMemory()` loses tokens on restart; `layerConfig` cannot persist
refreshes. Refresh rotates both tokens with compare-and-set persistence; a successful new login
replaces only the explicitly named credential and gives it a new `extra.identity`, which refresh
preserves. No legacy auth file is read, imported, or overwritten automatically. Use distinct names
to retain an existing API key/account, or explicitly migrate its credentials in your host.

Subscription requests identify as Claude Code using its required system prefix, headers, and
tool-name normalization. This is an unofficial compatibility integration, not an Anthropic-supported
API-key replacement: provider policy, subscription access, or protocol changes may break it.
Review Anthropic's terms before use. Newer Claude models that require thinking-prefix rebinding
use adaptive reasoning even when no reasoning effort is selected; incompatible explicit native
thinking modes are rejected. Tool schemas and tool arguments remain opaque during wire
transformations, and tool-result images are preserved.
`provider.listModels` discovers the account's models using the same refreshed tokens. Configure
`models` when serving a discovered model not yet present in the bundled catalog.
For model IDs whose discovery metadata advertises adaptive thinking, pass
`adaptiveModels: ['discovered-model-id']` alongside `models`. This preserves adaptive mode and
reasoning effort for models that the static catalog does not yet know.
Claude OAuth is exposed directly rather than through the stock Accounts device-code adapter;
hosts using an account registry should own the browser authorization interaction.

When people add and remove accounts while the loop runs, use [Accounts](#accounts). Underneath,
`Model.layerDynamic(providers)` reads the providers at each request.

For any other backend, `LanguageModelProvider.make` adapts an effect/ai `LanguageModel`. Our
loop runs the tools, so tool resolution is off; `languageModel` runs once per request.

`Faux` is pi-ai's scripted provider, for tests. It can stream text, thinking and tool calls,
fail, or answer from the request.

## Accounts

For a host whose people add accounts while it runs. An adapter declares a provider type once, in
code: its settings Schema and how its accounts sign in. Accounts are its instances, added at run
time; each one is a provider named after the account, with its credential stored under that name.

```ts
// shared: adapters import no SDK, so the browser can use them
import { Adapter } from 'effect-harness/accounts'
import { OpenAi, OpenAiCodex } from 'effect-harness/openai/adapter'
export const adapters = Adapter.group(OpenAiCodex.adapter, OpenAi.adapter)

// server: each adapter's implementation is a layer; a missing one is a type error
const Live = HarnessServer.layer().pipe(
  Layer.provide(Accounts.layerModel),
  Layer.provide(Accounts.layer(adapters)),
  Layer.provide([OpenAiCodex.layerAdapter(), OpenAi.layerAdapter]),
  Layer.provide([
    Credentials.layerKeyValueStore(),
    KeyValueStore.layerFileSystem(dir),
    FetchHttpClient.layer,
  ]),
)
```

```ts
const accounts = yield * Accounts.Accounts
yield *
  accounts.add({
    adapter: 'openai',
    name: 'openrouter',
    label: 'OpenRouter',
    settings: { apiUrl: 'https://openrouter.ai/api/v1' },
    apiKey: Redacted.make(key),
  })
yield *
  Stream.runDrain(accounts.signIn({ adapter: 'openai-codex', name: 'codex-work', label: 'Work' }))
yield * accounts.list // [{ name: 'openrouter', status: 'ready', ... }, ...]
```

Adding is one step: the account is kept only once listing models with its credential works. An
account that loses its credential stays, as `needsAuth`, until `setKey` or `signIn` fixes it.
`Accounts.layerServer` serves `AccountsRpcs` to a client, such as a browser; no RPC returns a
secret.

## Credentials

One `Credentials` service. The layer you pick decides where the secrets live:

| Layer                  | Where                                     |
| ---------------------- | ----------------------------------------- |
| `layerMemory(initial)` | in memory                                 |
| `layerKeyValueStore()` | a `KeyValueStore`, such as files on disk  |
| `layerConfig(names?)`  | `ConfigProvider` (.env), read-only        |
| `layerRpc`             | a remote store, over any transport        |
| `layerServer`          | serves the store in context to `layerRpc` |

```ts
const store = yield * Credentials.Credentials
yield * store.set('anthropic', { type: 'api_key', key: Redacted.make('sk-…') })
yield * store.list // [{ provider: 'anthropic', type: 'api_key' }]
```

Secrets decode to `Redacted`. `makeResolver({ refresh })` refreshes OAuth tokens before they
expire: one refresh per provider at a time, written back with a compare-and-set `update`.

## Storage

All three stores pass the same conformance suite and use pi's file and table formats.

```ts
Storage.layerMemory

// JSONL files in a directory, crash-recovering
Storage.layerJsonl('.harness').pipe(Layer.provide(BunServices.layer))

// any effect/sql SQLite or Postgres client
Storage.layerSql({ prefix: 'harness_' }).pipe(
  Layer.provide(SqliteClient.layer({ filename: 'harness.db' })),
)
```

## Splitting the client and the loop

There are two deployable parts, the client and the loop. In one process they talk over
`HarnessTransport.layerMemory`, which passes values through queues without encoding them.
To split them, change only the transport:

```ts
// loop process
const Server = HttpRouter.serve(
  HarnessServer.layer({ extensions: [CodingTools.extension] }).pipe(
    Layer.provide(HarnessTransport.layerWebSocketServer('/harness')),
    Layer.provide([CodingHandlers.layer, Models, Storage.layerJsonl('.harness')]),
  ),
).pipe(Layer.provide(BunHttpServer.layer({ port: 3000 })), Layer.provide(BunServices.layer))

// client: browser, CLI, another machine
const Client = HarnessClient.layer.pipe(
  Layer.provide(HarnessTransport.layerWebSocket('ws://localhost:3000/harness')),
)
```

`effect-harness/client` imports nothing the loop runs. A test enforces this, so the client
bundles for a browser. The same transports carry `CredentialsRpcs`, so several loops can share
one credential store.

## Deploying to Cloudflare

`effect-harness/cloudflare` runs the loop in a Durable Object, deployed with
[Alchemy](https://alchemy.run) (`alchemy` and `@effect/sql-sqlite-do` are optional peers). One
object is one loop with its accounts, credentials and conversations in the object's SQLite. Name
it after a user or a workspace.

```ts
// agent.ts
export default class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  'Agent',
  { schema: HarnessObject.Rpcs },
  // At deploy time, the Effect each activation runs.
  Effect.succeed(
    Effect.succeed(
      HarnessObject.layer({ adapters }).pipe(
        Layer.provide([OpenAiCodex.layerAdapter(), OpenAi.layerAdapter, FetchHttpClient.layer]),
      ),
    ),
  ),
) {}

// worker.ts: /agents/<name> reaches the object of that name, with the token
export default class Api extends Cloudflare.Worker<Api>()(
  'Api',
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent
    const token = yield* Config.Redacted('HARNESS_TOKEN')
    return { fetch: HarnessObject.route(agents, { token }) }
  }),
) {}

// client: the usual transport
HarnessClient.layer.pipe(
  Layer.provide(HarnessTransport.layerWebSocket(`wss://${host}/agents/julia?token=${token}`)),
)
```

Alchemy serves `HarnessObject.Rpcs` (the loop's requests and the account registry's) over
hibernatable WebSockets. While a task is live, the object keeps itself awake with its alarm. If
Cloudflare evicts or resets it anyway, the next activation resumes the tasks from SQLite, as after
any restart, and clients' watches open again. The pieces are also there on their own:
`HarnessObject.layerStorage`, `HarnessObject.layerKeepAwake`, and the handler layers
`HarnessServer.layerHandlers` and `Accounts.layerHandlers`.

[`examples/cloudflare`](examples/cloudflare) is a stack to run with `alchemy dev` or deploy, with
a command-line client.

A Worker has no file system or processes, so the coding tools and code mode do not run there, and
neither do the Bun and sharp image processors.

## Under the harness

The harness is built from layers you can use on their own.

**Session.** One mutation line over a `Storage`. Each `commit` is one atomic transaction over
conversations, entries, submissions, tasks and documents.

```ts
const Counter = Document.make<{ count: number }>({
  kind: 'app.counter',
  version: 1,
  scope: 'session',
  initial: () => Effect.succeed({ count: 0 }),
})

yield *
  session.commit((tx) =>
    Effect.map(tx.doc(Counter), (draft) => {
      draft.count += 1 // recorded as delta ops
    }),
  )

const watch = yield * session.watchDoc(Counter) // scoped
watch?.changes // Stream<{ value, ops }>
```

Documents are scoped to the session, a conversation (latest or rewindable, with fork rules), or
a task. A draft is a proxy that records edits as pi-identical ops (a port of Chord's delta
tracker).

**Tasks.** `Task.make` defines a durable state machine: a phase map over a JSON checkpoint,
plus an abort handler and migrations. The `Scheduler` runs tasks from the `Registry`, and
handles ownership, waits, abort cascades and restarts. The generation, tool and compaction
tasks are all built this way.

## Entry points

| Import                                    | What                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `effect-harness/client`                   | `HarnessClient`, `HarnessRpcs`, transports, `Init`                                               |
| `effect-harness/harness`                  | `Harness`, `HarnessServer`, `Generation`, `Compaction`, `Extension(s)`, `Settings`, `ToolSearch` |
| `effect-harness/tool`                     | `Tool`, `Toolkit`, `ToolResult`, `Call`, `ToolTask`                                              |
| `effect-harness/model`                    | `Model`, `Message`, `LanguageModelProvider`, `Faux`                                              |
| `effect-harness/openai`                   | `OpenAi` and `OpenAiCodex` providers and catalogs                                                |
| `effect-harness/anthropic`                | `Anthropic` and `AnthropicOAuth` providers, catalogs, and Claude subscription sign-in            |
| `effect-harness/accounts`                 | `Adapter`, `Accounts`, `Account`, `AccountsRpcs`, `AccountError`                                 |
| `…/openai/adapter`, `…/anthropic/adapter` | the stock adapters' declarations, safe in a client                                               |
| `effect-harness/credentials`              | `Credentials`, `Credential`, `CredentialsRpcs`                                                   |
| `effect-harness/coding`                   | `CodingTools`, `CodingHandlers`                                                                  |
| `effect-harness/codemode`                 | `Codemode`, `CodemodeHandlers`                                                                   |
| `effect-harness/session`                  | `Session`, `Document`, `Observation`                                                             |
| `effect-harness/task`                     | `Task`, `Registry`, `Scheduler`, `Hook`                                                          |
| `effect-harness/storage`                  | `Storage` (memory, JSONL, SQL), and `/schema`                                                    |
| `effect-harness/delta`                    | `Tracker`, `Ops`                                                                                 |
| `effect-harness/cloudflare`               | `HarnessObject`: the loop in a Durable Object, with Alchemy                                      |

## How it differs from pi

Field names, entry kinds and storage formats match pi. What changed:

- **Cancellation is hybrid.** A durable abort mark still drives the abort handler, so pending
  and crashed tasks can be aborted. A live run is stopped by Effect interruption.
- **Credentials replace the provider manager.** One service, many layers, read fresh before
  each request.
- **No execution environment.** Tools depend on services like `FileSystem`, and the layer you
  provide decides where they run.
- **Our own tool API.** It isn't effect/ai's toolkit, so handlers get the call ID and config,
  and every value crosses the task boundary encoded.
- **Streams instead of Chord's replicated state** for watches and views.
- **Errors, not throws.** A bad draft write fails the commit with `InvalidWrite`.

## Development

The `effecttsgo/unstable-api-usage` rule is disabled globally because platform, RPC, and AI APIs are intentional dependencies. Other lint rules and warning-as-error enforcement remain enabled.

```bash
bun install
bun run check   # format, lint, typecheck: must pass before a commit
bun run test    # bun test src
```

`repos/` vendors Effect and pi as read-only references.
