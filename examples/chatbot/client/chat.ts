/**
 * The chat panel: the model picker, the root conversation's transcript as it streams, and the
 * composer.
 */
import { Effect, Schema, Stream } from 'effect'
import { HarnessClient } from 'effect-harness/client'
import type { ViewState } from 'effect-harness/client'
import { Message } from 'effect-harness/model'
import type { Model } from 'effect-harness/model'
import type { Account } from 'effect-harness/accounts'
import { h } from './dom.ts'
import * as picker from './picker.ts'
import { AccountsClient, run } from './runtime.ts'
import { busy, items } from './transcript.ts'
import type { Item } from './transcript.ts'

type Change = Parameters<HarnessClient.Conversation['configure']>[0]

const isLevel = Schema.is(Message.ModelThinkingLevel)

/** The panel's parts, and what the picker shows. */
interface Chat {
  readonly select: HTMLSelectElement
  readonly thinking: HTMLSelectElement
  readonly notice: HTMLParagraphElement
  readonly messages: HTMLDivElement
  readonly status: HTMLElement
  readonly input: HTMLTextAreaElement
  groups: ReadonlyArray<Account.Models>
  current: Model.Ref | undefined
  reasoning: string
}

const conversation = Effect.flatMap(HarnessClient.HarnessClient, (client) => client.root())

const say = (chat: Chat) => (text: string) => {
  chat.notice.className = text === '' ? 'message' : 'message error'
  chat.notice.textContent = text
}

const bubble = (item: Item) =>
  item.type === 'user'
    ? h('div', { class: 'bubble user' }, [item.text])
    : h('div', { class: item.pending ? 'bubble assistant pending' : 'bubble assistant' }, [
        h('small', { class: 'model' }, [item.model]),
        item.thinking !== '' && h('details', {}, [h('summary', {}, ['Thinking']), item.thinking]),
        item.text === '' && item.pending ? '…' : item.text,
        item.error !== undefined && h('p', { class: 'error' }, [item.error]),
      ])

const drawPicker = (chat: Chat) => {
  picker.fill(chat.select, chat.groups, chat.current)
  picker.fillThinking(chat.thinking, picker.listedOf(chat.groups, chat.current), chat.reasoning)
}

/** Read the agent's model and every account's models, then redraw the picker. */
const refresh = (chat: Chat) =>
  Effect.gen(function* () {
    const agent = yield* (yield* conversation).agent
    chat.current = agent.model
    chat.reasoning = agent.reasoning
    chat.groups = yield* (yield* AccountsClient).Models()
    drawPicker(chat)
  })

const configure = (chat: Chat, change: Change) =>
  Effect.flatMap(conversation, (found) => found.configure(change)).pipe(
    Effect.andThen(refresh(chat)),
  )

/** Send the composer's text, and say why when it gets no answer. */
const send = (chat: Chat, content: string) =>
  Effect.gen(function* () {
    say(chat)('')
    const submission = yield* (yield* conversation).submit({ type: 'input', content })
    const settled = yield* submission.wait
    if (settled.status === 'unanswered') {
      const detail = settled.detail === undefined ? '' : `: ${JSON.stringify(settled.detail)}`
      say(chat)(`No answer (${settled.reason})${detail}`)
    }
  })

const draw = (chat: Chat, view: ViewState.ConversationView) => {
  chat.messages.replaceChildren(...items(view).map((item) => bubble(item)))
  chat.messages.scrollTop = chat.messages.scrollHeight
  chat.status.textContent = busy(view) ? 'answering…' : ''
}

/** Draw the conversation's view, then every change of it. */
const watch = (chat: Chat) =>
  Effect.scoped(
    Effect.gen(function* () {
      const view = yield* (yield* conversation).view
      draw(chat, view.value)
      yield* Stream.runForEach(view.changes, ({ value }) =>
        Effect.sync(() => {
          draw(chat, value)
        }),
      )
    }),
  )

const listen = (chat: Chat, form: HTMLFormElement) => {
  chat.select.addEventListener('change', () => {
    const ref = picker.refOf(chat.select.value)
    if (ref !== undefined) run(configure(chat, { model: ref, reasoning: null }), say(chat))
  })
  chat.thinking.addEventListener('change', () => {
    const level = chat.thinking.value
    if (isLevel(level)) run(configure(chat, { reasoning: level }), say(chat))
  })
  const submit = (event: Event) => {
    event.preventDefault()
    const content = chat.input.value.trim()
    if (content === '') return
    chat.input.value = ''
    run(send(chat, content), say(chat))
  }
  form.addEventListener('submit', submit)
  chat.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) submit(event)
  })
}

export const mount = (root: HTMLElement) => {
  const chat: Chat = {
    select: h('select', { class: 'model', attrs: { 'aria-label': 'Model' } }),
    thinking: h('select', { class: 'thinking', attrs: { 'aria-label': 'Thinking' } }),
    notice: h('p', { class: 'message' }),
    messages: h('div', { class: 'messages' }),
    status: h('small', { class: 'status' }),
    input: h('textarea', { attrs: { placeholder: 'Message', rows: '2' } }),
    groups: [],
    current: undefined,
    reasoning: 'off',
  }
  const form = h('form', { class: 'composer' }, [
    chat.input,
    h('button', { class: 'primary', attrs: { type: 'submit' } }, ['Send']),
  ])
  const reload = () => {
    run(refresh(chat), say(chat))
  }
  const reset = () => {
    run(
      Effect.flatMap(conversation, (found) => found.reset()),
      say(chat),
    )
  }
  root.replaceChildren(
    h('header', {}, [
      chat.select,
      chat.thinking,
      h('button', { attrs: { type: 'button', title: 'Reload models' }, on: { click: reload } }, [
        '↻',
      ]),
      h('button', { attrs: { type: 'button' }, on: { click: reset } }, ['New context']),
      chat.status,
    ]),
    chat.messages,
    chat.notice,
    form,
  )
  listen(chat, form)
  drawPicker(chat)
  reload()
  run(watch(chat), say(chat))
  return { refresh: reload }
}
