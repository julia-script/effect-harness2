/**
 * The providers the chatbot supports, declared once. The browser draws its forms from them and the
 * server implements them; how many accounts each has is up to the people using it.
 */
import { Adapter } from 'effect-harness/accounts'
import { Anthropic } from 'effect-harness/anthropic/adapter'
import { OpenAi, OpenAiCodex } from 'effect-harness/openai/adapter'

export const adapters = Adapter.group(OpenAiCodex.adapter, OpenAi.adapter, Anthropic.adapter)
