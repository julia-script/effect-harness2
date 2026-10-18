/**
 * Catalog entries of the stock providers: a `Definition` plus what a provider needs to map the
 * request options for that model.
 */
import type { ModelThinkingLevel } from '../Message.ts'
import type { Definition } from '../Model.ts'

export interface Entry extends Definition {
  /** The provider's effort for each thinking level; `null` where the model does not have it. */
  readonly efforts?: Partial<Record<ModelThinkingLevel, string | null>>
  /** Thinks adaptively: it takes an effort, never a token budget. */
  readonly adaptive?: boolean
  /** `false` when the model rejects `temperature`. */
  readonly temperature?: boolean
}

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The effort `entry` names for `level`, or for the nearest level it has: lower first, then higher.
 * `undefined` when the entry names no efforts.
 */
export const effort = (
  entry: Entry | undefined,
  level: (typeof LEVELS)[number],
): string | undefined => {
  const efforts = entry?.efforts
  if (efforts === undefined) return undefined
  const at = LEVELS.indexOf(level)
  const order = [...LEVELS.slice(0, at + 1).toReversed(), ...LEVELS.slice(at + 1)]
  for (const candidate of order) {
    const value = efforts[candidate]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** The entry of `id` among `models`. */
export const find = (models: ReadonlyArray<Entry>, id: string): Entry | undefined =>
  models.find((entry) => entry.id === id)
