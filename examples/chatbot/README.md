# Chatbot demo

A browser chatbot over several model providers at once. People add and remove accounts while it
runs (Codex sign-ins, OpenAI and Anthropic keys, any OpenAI-compatible endpoint), and the model
picker shows every account's models, listed live over its own credential.

```bash
bun run demo:chatbot   # builds the browser app, serves http://127.0.0.1:3000
```

`HOST`, `PORT` and `DATA_DIR` (default `.chatbot`) change where it listens and what it keeps.
Accounts, credentials and conversations survive a restart.

To try it without real accounts, run the stand-in APIs and point Codex at them:

```bash
bun examples/chatbot/test/upstream.ts            # prints http://127.0.0.1:<port>
CODEX_AUTH_URL=http://127.0.0.1:<port> CODEX_BASE_URL=http://127.0.0.1:<port> bun run demo:chatbot
# then add an OpenAI-compatible account at http://127.0.0.1:<port>/v1 with any key starting sk-
```

## How it fits together

```
browser ──/harness──▶ HarnessServer ──▶ Model.layerDynamic ──▶ the accounts' providers
        ──/accounts─▶ AccountsRpcs  ──▶ Accounts registry ──▶ KeyValueStore (accounts)
                                                         └──▶ Credentials (keys, tokens)
```

- `shared/` holds the Schemas and the `AccountsRpcs` group both sides use.
- `server/Accounts.ts` is the registry. An account is a provider: a kind, a name that requests route
  by and its credential is stored under, and an optional endpoint. Each provider is built once,
  when its account is added, and `Model.layerDynamic` routes to the set as it is at each request.
- Adding a key checks it first by listing models with it. A custom endpoint serves exactly what it
  listed.
- Codex signs in on the server and streams the device code to the browser; the browser never holds
  a secret.
- `client/` is plain DOM over `HarnessClient` and an `AccountsRpcs` client, each on a WebSocket.

## API friction

What building this showed about the library. The first two are fixed in the same change.

1. **The provider set was fixed when the layer was built.** Adding an account needs a new provider
   while the loop runs. Fixed: `Model.makeDynamic` / `Model.layerDynamic` read the providers at each
   call, and `Model.Service`'s `models` and `info` are Effects.
2. **No writable credential store survived a restart.** Memory loses Codex tokens; config is
   read-only. Fixed: `Credentials.layerKeyValueStore`, over any `KeyValueStore`.
3. **The registry is app code every multi-provider host will rewrite.** Providers are values with
   closures, which is right for code, but a UI registers providers as data. `server/Accounts.ts`
   and its internals (about 250 lines) persist account configs, build each provider once, key
   credentials by name, and clean up on removal. A library `Providers` registry with a Schema'd
   config union and an RPC group would cover it.
4. **Codex sign-in has to run on the server.** The README shows `OpenAiCodex.login` "from the
   client", but a browser must not hold a writable `Credentials`, and auth.openai.com most likely
   refuses cross-origin calls (not tried against the real server). The demo wraps `login` in a streaming RPC; the library could ship that RPC.
5. **`CredentialsRpcs` can't face a browser.** It serves `Get`, which returns secrets. A
   write-and-list subset would let a client manage keys without reading them.
6. **Listed models a provider doesn't already know are `served: false`.** A custom endpoint lists
   models no catalog has, so the demo lists them when the account is added and passes them as
   `models`. Codex has the same gap: a model its backend lists but the pi-ai catalog lacks (here
   `gpt-next`) can't be picked, though the listing carries its efforts and context window.
7. **Only the Responses API.** Many OpenAI-compatible servers speak only Chat Completions.
   `@effect/ai-openai-compat` 4.0.5 could back an `OpenAiCompat` provider.
8. **No model list from a provider's own models.** When listing fails the demo falls back to what
   the provider serves, and has to map `Model.Info` to `Model.Listed` by hand.
9. **Clients decode the view themselves.** `ConversationView.docs` is `JsonObject`, so the client
   decodes `pi.live` with `ViewState.LiveState`, decodes each entry's `model` messages, and knows
   which roles to show. `AgentState` isn't exported from `effect-harness/client`, so the
   `configure` argument type comes from `Parameters<...>`.
10. **An unanswered run leaves nothing in the transcript.** `no_model`, or a request the provider
    rejected without a response, is only on the submission record. After a reload the chat can't
    say why a message got no answer.
11. **A client can't list conversations.** It has the root, create, fork, and lookup by ID, so the
    demo uses the root conversation only.
12. **App RPCs need their own socket.** `HarnessServer` serves `HarnessRpcs` on the protocol in
    context, so `AccountsRpcs` is served at `/accounts` beside it.
13. **Codex sign-in returns no account identity**, such as the email, so people must label each
    account themselves.
