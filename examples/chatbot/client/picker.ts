/**
 * The model picker: every account's models, grouped by account, and the thinking levels of the
 * chosen one.
 */
import type { Model } from 'effect-harness/model'
import type { Models } from '../shared/Account.ts'
import { h } from './dom.ts'

const SEPARATOR = '\u0000'

export const valueOf = (ref: Model.Ref) => `${ref.provider}${SEPARATOR}${ref.modelId}`

export const refOf = (value: string): Model.Ref | undefined => {
  const [provider, modelId] = value.split(SEPARATOR)
  return provider === undefined || modelId === undefined || provider === ''
    ? undefined
    : { provider, modelId }
}

/** The listed model `ref` names. */
export const listedOf = (groups: ReadonlyArray<Models>, ref: Model.Ref | undefined) =>
  ref === undefined
    ? undefined
    : groups
        .find(({ account }) => account.name === ref.provider)
        ?.models.find(({ id }) => id === ref.modelId)

const group = (models: Models) => {
  const label = `${models.account.label} (${models.account.name})`
  const options = models.models.map((listed) =>
    h(
      'option',
      {
        attrs: {
          value: valueOf({ provider: models.account.name, modelId: listed.id }),
          disabled: !listed.served,
        },
      },
      [listed.served ? listed.name : `${listed.name} (not served)`],
    ),
  )
  const warning =
    models.error === undefined
      ? []
      : [h('option', { attrs: { disabled: true } }, [`⚠ ${models.error}`])]
  return h('optgroup', { attrs: { label } }, [...warning, ...options])
}

/** Fill `select` with `groups`, choosing `current`; one not listed stays as an orphan option. */
export const fill = (
  select: HTMLSelectElement,
  groups: ReadonlyArray<Models>,
  current: Model.Ref | undefined,
) => {
  const missing =
    current !== undefined && listedOf(groups, current) === undefined
      ? [
          h('option', { attrs: { value: valueOf(current) } }, [
            `${current.provider}/${current.modelId} (unavailable)`,
          ]),
        ]
      : []
  select.replaceChildren(
    h('option', { attrs: { value: '', disabled: true } }, [
      groups.length === 0 ? 'Add an account to pick a model' : 'Pick a model',
    ]),
    ...missing,
    ...groups.map((models) => group(models)),
  )
  select.value = current === undefined ? '' : valueOf(current)
}

/** Fill `select` with the thinking levels of `listed`, choosing `current`. */
export const fillThinking = (
  select: HTMLSelectElement,
  listed: Model.Listed | undefined,
  current: string,
) => {
  const levels = ['off', ...(listed?.thinkingLevels ?? []).filter((level) => level !== 'off')]
  select.replaceChildren(
    ...levels.map((level) => h('option', { attrs: { value: level } }, [`thinking: ${level}`])),
  )
  select.value = levels.includes(current) ? current : 'off'
  select.disabled = listed?.thinkingLevels === undefined
}
