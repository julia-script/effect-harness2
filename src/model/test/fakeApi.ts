/**
 * Test support: a local HTTP server standing in for a provider API. It records each request and
 * answers with the server-sent events `respond` gives.
 */
import { Effect } from 'effect'
import type { Scope } from 'effect'

export interface Recorded {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface FakeApi {
  /** The server's base URL. */
  readonly url: string
  readonly requests: ReadonlyArray<Recorded>
}

const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

/** Serve on an ephemeral port while the scope is open. */
export const serve = (
  respond: (request: Recorded) => ReadonlyArray<unknown>,
): Effect.Effect<FakeApi, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => {
        const requests: Array<Recorded> = []
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request) =>
            request.text().then((text) => {
              const recorded: Recorded = {
                path: new URL(request.url).pathname,
                headers: Object.fromEntries(request.headers),
                body: text === '' ? undefined : JSON.parse(text),
              }
              requests.push(recorded)
              return new Response(sse(respond(recorded)), {
                headers: { 'content-type': 'text/event-stream' },
              })
            }),
        })
        return { server, requests }
      }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
    ({ server, requests }): FakeApi => ({ url: `http://127.0.0.1:${server.port}`, requests }),
  )
