/**
 * What the chat shows of a conversation's view: its user and assistant messages, then the answer
 * being generated, from the `pi.live` document.
 */
import { Option, Schema } from 'effect'
import { ViewState } from 'effect-harness/client'
import { Message } from 'effect-harness/model'

export type Item =
  | { readonly type: 'user'; readonly text: string }
  | {
      readonly type: 'assistant'
      readonly text: string
      readonly thinking: string
      readonly model: string
      readonly error?: string
      readonly pending: boolean
    }

const decodeMessage = Schema.decodeUnknownOption(Message.Message)
const decodeLive = Schema.decodeUnknownOption(ViewState.LiveState)

const userText = (message: Message.UserMessage) =>
  typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('')

const assistant = (message: Message.AssistantMessage, pending: boolean): Item => ({
  type: 'assistant',
  text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
  thinking: message.content.map((part) => (part.type === 'thinking' ? part.thinking : '')).join(''),
  model: `${message.provider}/${message.model}`,
  ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
  pending,
})

const itemOf = (message: Message.Message): ReadonlyArray<Item> => {
  if (message.role === 'user') return [{ type: 'user', text: userText(message) }]
  if (message.role === 'assistant') return [assistant(message, false)]
  return []
}

export const items = (view: ViewState.ConversationView): ReadonlyArray<Item> => {
  const committed = view.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((json) =>
      Option.toArray(decodeMessage(json)).flatMap((message) => itemOf(message)),
    ),
  )
  const live = decodeLive(view.docs['pi.live'] ?? {})
  const partial = Option.isSome(live) ? live.value.generation?.message : undefined
  return partial === undefined ? committed : [...committed, assistant(partial, true)]
}

/** Whether a run is live: an answer is on its way. */
export const busy = (view: ViewState.ConversationView): boolean => {
  const live = decodeLive(view.docs['pi.live'] ?? {})
  return Option.isSome(live) && live.value.run !== undefined
}
