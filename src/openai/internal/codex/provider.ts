/**
 * The Codex provider: the Responses API at ChatGPT's backend, over `@effect/ai-openai` with the
 * stored OAuth access token, the account id header, `store: false`, and the system prompt as
 * `instructions`, as pi-ai sends them.
 */
import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { Effect, Redacted, Semaphore } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import * as Credentials from '../../../credentials/Credentials.ts'
import * as LanguageModelProvider from '../../../model/LanguageModelProvider.ts'
import type { Info, Request } from '../../../model/Model.ts'
import { ModelError, Rejected } from '../../../model/ModelError.ts'
import * as Transcript from '../../../model/Transcript.ts'
import type { Options } from '../../OpenAiCodex.ts'
import { config as responsesConfig } from '../provider.ts'
import { AUTH_URL, accountId, refresh } from './auth.ts'
import { models as catalog } from './catalog.ts'

const NAME = 'openai-codex'
const BASE_URL = 'https://chatgpt.com/backend-api'

const rejected = (message: string, cause?: unknown) =>
  new ModelError({ message, reason: new Rejected({}), ...(cause === undefined ? {} : { cause }) })

/** The request options Codex takes: no output limit, nothing stored, instructions required. */
const config = (model: Info, request: Request) => {
  const { max_output_tokens: _limit, ...rest } = responsesConfig(model, request, catalog)
  const sessionId = request.options?.sessionId
  return {
    ...rest,
    store: false,
    instructions: Transcript.systemPrompt(request.messages) || 'You are a helpful assistant.',
    include: ['reasoning.encrypted_content' as const],
    ...(sessionId === undefined ? {} : { prompt_cache_key: sessionId }),
  }
}

export const make = (options: Options) => {
  // One refresh at a time for this provider, so concurrent requests near expiry refresh once.
  const line = Semaphore.makeUnsafe(1)
  const authUrl = options.authUrl ?? AUTH_URL
  const tokens = (http: HttpClient.HttpClient) =>
    Credentials.makeResolver({
      refresh: (_provider, stored) =>
        Effect.provideService(refresh(authUrl, stored), HttpClient.HttpClient, http),
    }).pipe(
      Effect.flatMap((resolve) => resolve(NAME)),
      Semaphore.withPermit(line),
      Effect.mapError((cause) => rejected(`Codex credentials: ${cause.message}`, cause)),
      Effect.flatMap((credential) =>
        credential?.type === 'oauth'
          ? Effect.succeed(Redacted.value(credential.access))
          : Effect.fail(rejected('Sign in to Codex first: no openai-codex tokens are stored')),
      ),
    )
  return LanguageModelProvider.make({
    name: NAME,
    api: 'openai-codex-responses',
    models: options.models ?? catalog,
    system: 'separate',
    languageModel: (model, request) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const access = yield* tokens(http)
        const account = accountId(access)
        if (account === undefined) return yield* rejected('The Codex token has no account id')
        const sessionId = request.options?.sessionId
        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make(access),
          apiUrl: `${options.baseUrl ?? BASE_URL}/codex`,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeaders({
              'chatgpt-account-id': account,
              'OpenAI-Beta': 'responses=experimental',
              originator: options.originator ?? 'effect-harness',
              ...(sessionId === undefined ? {} : { 'session-id': sessionId }),
            }),
          ),
        })
        return yield* OpenAiLanguageModel.make({
          model: model.id,
          config: config(model, request),
        }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client))
      }),
  })
}
