/**
 * The provider of each kind of account, and its catalog as a model list for when listing fails.
 */
import type { Model } from 'effect-harness/model'
import { Anthropic } from 'effect-harness/anthropic'
import { OpenAi, OpenAiCodex } from 'effect-harness/openai'
import type { Account } from '../../shared/Account.ts'
import type { Options, Requires } from '../Accounts.ts'

const custom = (account: Account) => ({
  ...(account.apiUrl === undefined ? {} : { apiUrl: account.apiUrl }),
  ...(account.models === undefined ? {} : { models: account.models.map((id) => ({ id })) }),
})

/** The provider of `account`, which reads its credential from `Credentials` for each request. */
export const of = (account: Account, options: Options): Model.Listable<Requires> => {
  if (account.kind === 'openai-codex') {
    return OpenAiCodex.provider({ name: account.name, ...options.codex })
  }
  if (account.kind === 'anthropic')
    return Anthropic.provider({ name: account.name, ...custom(account) })
  return OpenAi.provider({ name: account.name, ...custom(account) })
}

/** The models `provider` serves, as a model list shows them. */
export const served = (provider: Model.Provider<Requires>): ReadonlyArray<Model.Listed> =>
  provider.models.map((info) => ({
    provider: info.provider,
    id: info.id,
    name: info.name,
    served: true,
    serviceTiers: [],
    contextWindow: info.contextWindow,
  }))
