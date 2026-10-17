import type { JsonObject, Op } from './schema/index.ts'

/**
 * Document delta replay for storage backends, after pi's `chord/delta` applier.
 *
 * Ops are data, so every op is validated before use: unknown verbs, wrong arities, and path
 * segments that reach the prototype chain are rejected, and writes use `defineProperty` so an
 * inherited setter never runs.
 */

type Segment = string | number
type Path = ReadonlyArray<Segment>
type Container = unknown[] | Record<string, unknown>
type ArrayOp = Extract<Op, readonly ['p' | 'm', ...ReadonlyArray<unknown>]>
type LeafOp = Extract<Op, readonly ['s' | 'd' | 'a' | 't', ...ReadonlyArray<unknown>]>

interface Shape {
  readonly arity: number
  /** Whether the path must be non-empty; absent for `r`, which has no path. */
  readonly nonEmptyPath?: boolean
  readonly check?: (op: ReadonlyArray<unknown>) => boolean
}

/** Segments that would reach the prototype chain through `parent[key] = value`. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const isContainer = (value: unknown): value is Container =>
  value !== null && typeof value === 'object'

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

export const isJsonObject = (value: unknown): value is JsonObject =>
  isContainer(value) && !Array.isArray(value)

const pathError = (path: Path): Error =>
  new Error(`Unresolvable document path: ${JSON.stringify(path)}`)

const define = (target: Container, key: Segment, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

const assertSafePath = (path: unknown, nonEmpty: boolean): void => {
  if (!Array.isArray(path)) throw new TypeError('Document op path is not an array')
  if (nonEmpty && path.length === 0) throw new TypeError('Document op path is empty')
  for (const segment of path) {
    const safe =
      typeof segment === 'string' ? !RESERVED_SEGMENTS.has(segment) : isNonNegativeInt(segment)
    if (!safe) throw new TypeError(`Unsafe document path segment: ${String(segment)}`)
  }
}

const isPermutation = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false
  const seen = new Uint8Array(value.length)
  for (const index of value) {
    if (!isNonNegativeInt(index) || index >= value.length || seen[index] !== 0) return false
    seen[index] = 1
  }
  return true
}

/** Arity, path, and payload rules of each decoded verb. */
const SHAPES: ReadonlyMap<unknown, Shape> = new Map<string, Shape>([
  ['r', { arity: 2 }],
  ['s', { arity: 3, nonEmptyPath: true }],
  ['d', { arity: 2, nonEmptyPath: true }],
  ['a', { arity: 3, nonEmptyPath: true, check: (op) => typeof op[2] === 'string' }],
  ['t', { arity: 3, nonEmptyPath: true, check: (op) => isNonNegativeInt(op[2]) }],
  [
    'p',
    {
      arity: 5,
      nonEmptyPath: false,
      check: (op) => isNonNegativeInt(op[2]) && isNonNegativeInt(op[3]) && Array.isArray(op[4]),
    },
  ],
  ['m', { arity: 3, nonEmptyPath: false, check: (op) => isPermutation(op[2]) }],
])

/** Verb, arity, and payload shape of a decoded op; throws for anything else. */
const assertValidOp = (op: ReadonlyArray<unknown>): void => {
  const verb = op[0]
  const shape = SHAPES.get(verb)
  // Silently skipping an unknown verb is how a newer producer's op vanishes.
  if (shape === undefined) throw new TypeError(`Unknown document op verb: ${String(verb)}`)
  if (op.length !== shape.arity) throw new TypeError(`Document op ${String(verb)} arity`)
  if (shape.nonEmptyPath !== undefined) assertSafePath(op[1], shape.nonEmptyPath)
  if (shape.check !== undefined && !shape.check(op)) {
    throw new TypeError(`Document op ${String(verb)} shape`)
  }
}

/** Walk own properties only, so a path never escapes into the prototype chain. */
const resolve = (root: unknown, path: Path): Container => {
  let node = root
  for (const segment of path) {
    if (!isContainer(node)) throw pathError(path)
    if (Array.isArray(node) && typeof segment !== 'number') throw pathError(path)
    if (!Object.hasOwn(node, segment)) throw pathError(path)
    const child: unknown = Reflect.get(node, segment)
    node = child
  }
  if (!isContainer(node)) throw pathError(path)
  return node
}

const applyArrayOp = (root: unknown, op: ArrayOp): void => {
  const target = resolve(root, op[1])
  if (!Array.isArray(target)) throw pathError(op[1])
  if (op[0] === 'p') {
    target.splice(op[2], op[3], ...structuredClone(op[4]))
    return
  }
  const permutation = op[2]
  if (target.length !== permutation.length) throw pathError(op[1])
  const previous = [...target]
  for (const [index, from] of permutation.entries()) target[index] = previous[from]
}

const applyLeafOp = (root: unknown, op: LeafOp): void => {
  const path = op[1]
  const parent = resolve(root, path.slice(0, -1))
  const key = path.at(-1) ?? ''
  // Writing past the end would leave a hole that does not survive a JSON round trip.
  if (Array.isArray(parent) && (typeof key !== 'number' || key > parent.length)) {
    throw pathError(path)
  }
  if (op[0] === 's') {
    define(parent, key, structuredClone(op[2]))
  } else if (op[0] === 'd') {
    if (!Array.isArray(parent)) Reflect.deleteProperty(parent, key)
    else if (typeof key === 'number' && key < parent.length) parent.splice(key, 1)
    else throw pathError(path)
  } else {
    const current: unknown = Object.hasOwn(parent, key) ? Reflect.get(parent, key) : undefined
    if (typeof current !== 'string') throw pathError(path)
    define(parent, key, op[0] === 'a' ? `${current}${op[2]}` : current.slice(op[2]))
  }
}

const isArrayOp = (op: Op): op is ArrayOp => op[0] === 'p' || op[0] === 'm'

/**
 * Replay op batches on a detached copy of `base`. Neither the base nor any op payload is shared
 * with the result, so callers may hand it out without cloning again.
 */
export const applyBatches = (base: JsonObject, batches: Iterable<ReadonlyArray<Op>>): unknown => {
  let root: unknown = structuredClone(base)
  for (const ops of batches) {
    for (const op of ops) {
      assertValidOp(op)
      if (op[0] === 'r') root = structuredClone(op[1])
      else if (isArrayOp(op)) applyArrayOp(root, op)
      else applyLeafOp(root, op)
    }
  }
  return root
}
