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
browser ──/harness──▶ HarnessServer ──▶ Accounts.layerModel ──▶ the accounts' providers
        ──/accounts─▶ AccountsRpcs  ──▶ Accounts registry ──▶ KeyValueStore (accounts)
                                                         └──▶ Credentials (keys, tokens)
```

- `shared/adapters.ts` declares the three adapters the chatbot supports: Codex, OpenAI (and any
  OpenAI-compatible endpoint), and Anthropic. The browser draws its forms from them.
- `server/main.ts` implements them with the stock implementations and serves the library's
  `Accounts` registry; the chatbot has no registry code of its own.
- Adding a key checks it first by listing models with it. A custom endpoint serves exactly what it
  listed.
- Codex signs in on the server and streams the device code to the browser; the browser never holds
  a secret.
- An account that loses its credential shows a red dot and why, and its models can't be picked
  until it signs in again or gets a new key.
- `client/` is plain DOM over `HarnessClient` and an `AccountsRpcs` client, each on a WebSocket.
  The accounts list follows the registry's `Changes` stream.

## API friction

What building this showed about the library. The first three are fixed in the same change, and
4, 5 and 6 in part.

1. **The provider set was fixed when the layer was built.** Adding an account needs a new provider
   while the loop runs. Fixed: `Model.makeDynamic` / `Model.layerDynamic` read the providers at each
   call, and `Model.Service`'s `models` and `info` are Effects.
2. **No writable credential store survived a restart.** Memory loses Codex tokens; config is
   read-only. Fixed: `Credentials.layerKeyValueStore`, over any `KeyValueStore`.
3. **The registry was app code every multi-provider host would rewrite.** Fixed:
   `effect-harness/accounts`. Adapters are declared once and implemented on the server; accounts
   are added at run time. The demo's 250 lines of registry are gone.
4. **Codex sign-in has to run on the server.** A browser must not hold a writable `Credentials`,
   and auth.openai.com most likely refuses cross-origin calls (not tried against the real server).
   `AccountsRpcs.SignIn` streams the device code to the client now.
5. **`CredentialsRpcs` can't face a browser.** It serves `Get`, which returns secrets.
   `AccountsRpcs` can: keys only travel inward. `CredentialsRpcs` itself is unchanged.
6. **Listed models a provider doesn't already know are `served: false`.** For a custom endpoint the
   registry now keeps what the account listed, and the OpenAI implementation serves it. Codex still
   has the gap: a model its backend lists but the pi-ai catalog lacks (here `gpt-next`) can't be
   picked, though the listing carries its efforts and context window.
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
