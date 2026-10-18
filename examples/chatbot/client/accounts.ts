/**
 * The accounts panel: the registered accounts, a form to add one, and the Codex device sign-in.
 */
import { Deferred, Effect, Redacted, Stream } from 'effect'
import type { SignInEvent, Status } from '../shared/Account.ts'
import { h, valueOf } from './dom.ts'
import { AccountsClient, run } from './runtime.ts'

type Choice = 'openai-codex' | 'openai' | 'openai-compatible' | 'anthropic'

const CHOICES: ReadonlyArray<readonly [Choice, string]> = [
  ['openai-codex', 'ChatGPT (Codex)'],
  ['openai', 'OpenAI'],
  ['openai-compatible', 'OpenAI-compatible'],
  ['anthropic', 'Anthropic'],
]

const KIND_LABELS: Readonly<Record<Status['kind'], string>> = {
  'openai-codex': 'ChatGPT (Codex)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

const DEFAULT_LABELS: Readonly<Record<Choice, string>> = {
  'openai-codex': 'ChatGPT',
  openai: 'OpenAI',
  'openai-compatible': 'My server',
  anthropic: 'Anthropic',
}

/** The panel's parts, and what its actions report to. */
interface Panel {
  readonly list: HTMLUListElement
  readonly form: HTMLFormElement
  readonly signIn: HTMLDivElement
  readonly say: (text: string, kind?: 'error' | 'info') => void
  /** The accounts changed: redraw the list, and tell the chat. */
  readonly changed: () => void
  choice: Choice
}

/** A name from `label`: `Work ChatGPT` is `work-chatgpt`. */
const slug = (label: string) =>
  label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 40)

const field = (name: string, label: string, attrs: Readonly<Record<string, string | boolean>>) =>
  h('label', {}, [label, h('input', { attrs: { name, ...attrs } })])

const fields = (choice: Choice): ReadonlyArray<HTMLElement> => [
  field('label', 'Label', { value: DEFAULT_LABELS[choice], required: true }),
  field('name', 'Name', { placeholder: 'from the label', pattern: '[a-z0-9][a-z0-9\\-]*' }),
  ...(choice === 'openai-compatible'
    ? [field('apiUrl', 'API URL', { placeholder: 'https://openrouter.ai/api/v1', required: true })]
    : []),
  ...(choice === 'openai-codex'
    ? []
    : [field('apiKey', 'API key', { type: 'password', required: true, autocomplete: 'off' })]),
]

const button = (label: string, onClick: () => void, className?: string) =>
  h(
    'button',
    {
      ...(className === undefined ? {} : { class: className }),
      attrs: { type: 'button' },
      on: { click: onClick },
    },
    [label],
  )

const showCode = (
  panel: Panel,
  event: Extract<SignInEvent, { type: 'code' }>,
  cancel: () => void,
) => {
  panel.signIn.replaceChildren(
    h('p', {}, [
      'Open ',
      h('a', { attrs: { href: event.url, target: '_blank', rel: 'noreferrer' } }, [event.url]),
      ' and enter this code:',
    ]),
    h('p', { class: 'code' }, [event.code]),
    h('p', { class: 'hint' }, ['Waiting for you to approve it…']),
    button('Cancel', cancel),
  )
}

/** Sign in to Codex as `name`, showing the device code, until approved or cancelled. */
const signIn = (panel: Panel, name: string, label: string) =>
  Effect.gen(function* () {
    panel.say('')
    panel.signIn.replaceChildren(h('p', {}, ['Asking ChatGPT for a sign-in code…']))
    const cancelled = yield* Deferred.make<void>()
    const cancel = () => {
      run(Deferred.succeed(cancelled, void 0), panel.say)
    }
    const accounts = yield* AccountsClient
    yield* accounts.SignInCodex({ name, label }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === 'code') {
            showCode(panel, event, cancel)
            return
          }
          panel.say(`Signed in as ${event.account.label}.`, 'info')
          renderForm(panel)
          panel.changed()
        }),
      ),
      Effect.race(Deferred.await(cancelled)),
    )
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        panel.signIn.replaceChildren()
      }),
    ),
  )

const remove = (panel: Panel, account: Status) =>
  Effect.flatMap(AccountsClient, (accounts) => accounts.Remove({ name: account.name })).pipe(
    Effect.tap(() => Effect.sync(panel.changed)),
  )

const row = (panel: Panel, account: Status) => {
  const where = account.apiUrl ?? KIND_LABELS[account.kind]
  return h('li', {}, [
    h('span', { class: account.signedIn ? 'dot on' : 'dot off' }),
    h('div', { class: 'who' }, [
      h('strong', {}, [account.label]),
      h('small', {}, [`${account.name} · ${where}`]),
    ]),
    account.kind === 'openai-codex' &&
      button(account.signedIn ? 'Sign in again' : 'Sign in', () => {
        run(signIn(panel, account.name, account.label), panel.say)
      }),
    button(
      'Remove',
      () => {
        run(remove(panel, account), panel.say)
      },
      'danger',
    ),
  ])
}

const refresh = (panel: Panel) =>
  Effect.flatMap(AccountsClient, (accounts) => accounts.List()).pipe(
    Effect.tap((all) =>
      Effect.sync(() => {
        panel.list.replaceChildren(...all.map((account) => row(panel, account)))
      }),
    ),
  )

const addApiKey = (panel: Panel, name: string, label: string) => {
  const apiUrl = valueOf(panel.form, 'apiUrl')
  panel.say('Checking the key…', 'info')
  return Effect.flatMap(AccountsClient, (accounts) =>
    accounts.AddApiKey({
      kind: panel.choice === 'anthropic' ? 'anthropic' : 'openai',
      name,
      label,
      apiKey: Redacted.make(valueOf(panel.form, 'apiKey')),
      ...(apiUrl === '' ? {} : { apiUrl }),
    }),
  ).pipe(
    Effect.tap((account) =>
      Effect.sync(() => {
        panel.say(`Added ${account.label}.`, 'info')
        renderForm(panel)
        panel.changed()
      }),
    ),
  )
}

const submit = (panel: Panel) => (event: Event) => {
  event.preventDefault()
  const label = valueOf(panel.form, 'label')
  const name = valueOf(panel.form, 'name') || slug(label)
  run(
    panel.choice === 'openai-codex' ? signIn(panel, name, label) : addApiKey(panel, name, label),
    panel.say,
  )
}

function renderForm(panel: Panel) {
  const tabs = CHOICES.map(([value, label]) =>
    button(
      label,
      () => {
        panel.choice = value
        renderForm(panel)
      },
      value === panel.choice ? 'tab active' : 'tab',
    ),
  )
  const action = panel.choice === 'openai-codex' ? 'Sign in with ChatGPT' : 'Add account'
  panel.form.replaceChildren(
    h('div', { class: 'tabs' }, tabs),
    ...fields(panel.choice),
    h('button', { class: 'primary', attrs: { type: 'submit' } }, [action]),
  )
}

export const mount = (root: HTMLElement, onChange: () => void) => {
  const message = h('p', { class: 'message' })
  const panel: Panel = {
    list: h('ul', { class: 'accounts' }),
    form: h('form', { class: 'add' }),
    signIn: h('div', { class: 'sign-in' }),
    say: (text, kind = 'error') => {
      message.className = `message ${kind}`
      message.textContent = text
    },
    changed: () => {
      run(refresh(panel), panel.say)
      onChange()
    },
    choice: 'openai-codex',
  }
  panel.form.addEventListener('submit', submit(panel))
  renderForm(panel)
  root.replaceChildren(
    h('h2', {}, ['Accounts']),
    panel.list,
    h('h3', {}, ['Add an account']),
    panel.form,
    panel.signIn,
    message,
  )
  run(refresh(panel), panel.say)
}
