import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { applyBatches } from './delta.ts'
import type { JsonObject, Op } from './schema/index.ts'

const replay = (base: JsonObject, batches: ReadonlyArray<ReadonlyArray<Op>>) =>
  Effect.runSync(applyBatches(base, batches))

const problem = (base: JsonObject, op: Op) =>
  Effect.runSync(
    applyBatches(base, [[op]]).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => 'applied' }),
    ),
  )

test('replays every verb on a detached copy of the base', () => {
  const base = { text: 'hello', list: [1, 2, 3], gone: true }
  const ops: ReadonlyArray<Op> = [
    ['a', ['text'], ' world'],
    ['t', ['text'], 6],
    ['p', ['list'], 1, 1, [9, 8]],
    ['m', ['list'], [3, 2, 1, 0]],
    ['d', ['gone']],
    ['s', ['added'], { nested: [] }],
  ]
  expect(replay(base, [ops])).toEqual({
    text: 'world',
    list: [3, 8, 9, 1],
    added: { nested: [] },
  })
  expect(base).toEqual({ text: 'hello', list: [1, 2, 3], gone: true })
})

test('only `r` replaces the root, and later batches apply on top of it', () => {
  expect(replay({ a: 1 }, [[['r', { b: [] }]], [['p', ['b'], 0, 0, ['x']]]])).toEqual({ b: ['x'] })
})

test('fails on unsafe or unresolvable paths without polluting prototypes', () => {
  expect(problem({}, ['s', ['__proto__', 'polluted'], true])).toContain('Unsafe')
  expect(Reflect.get({}, 'polluted')).toBeUndefined()
  expect(problem({}, ['s', ['missing', 'key'], 1])).toContain('Unresolvable')
  expect(problem({ list: [] }, ['s', ['list', 5], 1])).toContain('Unresolvable')
  expect(problem({ list: [1] }, ['m', ['list'], [0, 0]])).toContain('shape')
})
