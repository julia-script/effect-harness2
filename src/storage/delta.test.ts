import { expect, test } from 'bun:test'
import { applyBatches } from './delta.ts'
import type { Op } from './schema/index.ts'

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
  expect(applyBatches(base, [ops])).toEqual({
    text: 'world',
    list: [3, 8, 9, 1],
    added: { nested: [] },
  })
  expect(base).toEqual({ text: 'hello', list: [1, 2, 3], gone: true })
})

test('only `r` replaces the root, and later batches apply on top of it', () => {
  expect(applyBatches({ a: 1 }, [[['r', { b: [] }]], [['p', ['b'], 0, 0, ['x']]]])).toEqual({
    b: ['x'],
  })
})

test('rejects unsafe or unresolvable paths without polluting prototypes', () => {
  expect(() => applyBatches({}, [[['s', ['__proto__', 'polluted'], true]]])).toThrow('Unsafe')
  expect(Reflect.get({}, 'polluted')).toBeUndefined()
  expect(() => applyBatches({}, [[['s', ['missing', 'key'], 1]]])).toThrow('Unresolvable')
  expect(() => applyBatches({ list: [] }, [[['s', ['list', 5], 1]]])).toThrow('Unresolvable')
  expect(() => applyBatches({ list: [1] }, [[['m', ['list'], [0, 0]]]])).toThrow('shape')
})
