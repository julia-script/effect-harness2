/**
 * The chatbot server: the harness loop at `/harness`, the account registry at `/accounts`, and the
 * browser app from `public/`. Accounts, credentials and conversations are kept in `DATA_DIR`
 * (default `.chatbot`), so they survive a restart.
 *
 *   bun run demo:chatbot   # builds the browser app, then runs this on HOST:PORT (127.0.0.1:3000)
 */
import { BunHttpServer, BunRuntime } from '@effect/platform-bun'
import { Config, Effect, Layer, Option } from 'effect'
import { FetchHttpClient, HttpRouter, HttpStaticServer } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'
import { HarnessTransport } from 'effect-harness/client'
import { Credentials } from 'effect-harness/credentials'
import { HarnessServer } from 'effect-harness/harness'
import { Storage } from 'effect-harness/storage'
import * as Accounts from './Accounts.ts'
import * as AccountsServer from './AccountsServer.ts'

const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined))

const Settings = Config.all({
  port: Config.Port('PORT').pipe(Config.withDefault(3000)),
  hostname: Config.String('HOST').pipe(Config.withDefault('127.0.0.1')),
  dataDir: Config.String('DATA_DIR').pipe(Config.withDefault('.chatbot')),
  // Point Codex at stand-ins, for tests.
  authUrl: optional('CODEX_AUTH_URL'),
  baseUrl: optional('CODEX_BASE_URL'),
})

const app = ({ port, hostname, dataDir, authUrl, baseUrl }: Config.Success<typeof Settings>) => {
  const Loop = HarnessServer.layer().pipe(
    Layer.provide(HarnessTransport.layerWebSocketServer('/harness')),
    Layer.provide([Accounts.layerModel, Storage.layerJsonl(`${dataDir}/harness`)]),
  )
  const Registry = AccountsServer.layer.pipe(
    Layer.provide(HarnessTransport.layerWebSocketServer('/accounts')),
  )
  const Static = HttpStaticServer.layer({ root: `${import.meta.dir}/../public` })
  const codex = {
    ...(authUrl === undefined ? {} : { authUrl }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  }
  return HttpRouter.serve(Layer.mergeAll(Loop, Registry, Static)).pipe(
    Layer.provide(Accounts.layer({ codex })),
    Layer.provide(Credentials.layerKeyValueStore()),
    Layer.provide(KeyValueStore.layerFileSystem(`${dataDir}/store`)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(BunHttpServer.layer({ port, hostname })),
  )
}

const App = Layer.unwrap(
  Effect.gen(function* () {
    return app(yield* Settings)
  }),
)

BunRuntime.runMain(Layer.launch(App))
