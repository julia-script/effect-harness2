import { applyBatches, isJsonObject } from '../delta.ts'
import { StorageRequestError } from '../schema/index.ts'
import type {
  DocumentContent,
  DocumentCreate,
  DocumentPoint,
  DocumentRecord,
  Op,
  Seq,
  StorageWrite,
  StoredDocument,
} from '../schema/index.ts'
import {
  getOrCreate,
  insertMapId,
  insertSorted,
  isAliveAt,
  isCurrentOnly,
  recordAddressKey,
  scopeKey,
  semantics,
} from './state.ts'
import type { DocumentAddressIndex, DocumentRevision, State, StoredDocumentState } from './state.ts'

/** Every command one commit gives one document. */
export interface DocumentAction {
  create?: DocumentCreate
  content?: DocumentContent
  retire: boolean
}

/** Ops of the deltas after a base, all of which must share its version. */
function* deltaBatches(
  id: number,
  version: number,
  revisions: ReadonlyArray<DocumentRevision>,
): Generator<ReadonlyArray<Op>> {
  for (const revision of revisions) {
    if (revision.kind !== 'delta' || revision.version !== version) {
      throw new Error(`Document ${id} crosses a stored version boundary without a base`)
    }
    yield revision.ops
  }
}

/** Replay one incarnation at a point. The returned value is detached; the record is not. */
export const materializeDocument = (
  state: State,
  id: number,
  at: DocumentPoint,
): StoredDocument | undefined => {
  const stored = state.documents.get(id)
  if (stored === undefined) return undefined
  if (at !== 'current' && isCurrentOnly(stored.record)) {
    throw new StorageRequestError({ message: `Document ${id} does not retain historical content` })
  }
  if (!isAliveAt(stored.record, at)) return undefined
  const revisions =
    at === 'current' ? stored.revisions : stored.revisions.filter((revision) => revision.seq <= at)
  const baseIndex = revisions.findLastIndex((revision) => revision.kind === 'base')
  const base = revisions[baseIndex]
  if (base?.kind !== 'base') throw new Error(`Document ${id} is missing a required base`)
  const value = applyBatches(
    base.value,
    deltaBatches(id, base.version, revisions.slice(baseIndex + 1)),
  )
  if (!isJsonObject(value)) throw new Error(`Document ${id} does not materialize to an object`)
  return {
    record: stored.record,
    version: base.version,
    value,
    deltasSinceBase: revisions.length - baseIndex - 1,
  }
}

const copiedBase = (
  state: State,
  write: Extract<StorageWrite, { readonly type: 'document.copy' }>,
  changed: ReadonlySet<number>,
): StorageWrite => {
  const { source, record } = write
  if (changed.has(source.id)) {
    throw new Error(`Fork source document ${source.id} is changed in the copy batch`)
  }
  const stored = materializeDocument(state, source.id, source.at)
  if (stored === undefined) throw new Error(`Fork source document ${source.id} cannot be read`)
  if (
    stored.record.scope.kind !== 'conversation' ||
    record.scope.kind !== 'conversation' ||
    stored.record.kind !== record.kind ||
    stored.record.key !== record.key ||
    semantics(stored.record) !== semantics(record)
  ) {
    throw new Error(`Fork source document ${source.id} does not match the copied record`)
  }
  return {
    type: 'document.create',
    record,
    content: { kind: 'base', version: stored.version, value: stored.value },
  }
}

/** Turn each `document.copy` into a `document.create` of its source's materialized base. */
export const resolveDocumentCopies = (
  state: State,
  writes: ReadonlyArray<StorageWrite>,
): ReadonlyArray<StorageWrite> => {
  if (!writes.some((write) => write.type === 'document.copy')) return writes
  const changed = new Set<number>()
  for (const write of writes) {
    if (write.type === 'document.create' || write.type === 'document.copy') {
      changed.add(write.record.id)
    } else if (write.type === 'document.change' || write.type === 'document.retire') {
      changed.add(write.id)
    }
  }
  return writes.map((write) => {
    if (write.type !== 'document.copy') return write
    try {
      return copiedBase(state, write, changed)
    } catch (error) {
      throw new Error(`Document copy ${write.record.id} was rejected`, { cause: error })
    }
  })
}

const actionFor = (actions: Map<number, DocumentAction>, id: number): DocumentAction =>
  getOrCreate(actions, id, (): DocumentAction => ({ retire: false }))

/** Group a batch's document commands by document, rejecting conflicting commands. */
export const prepareDocumentActions = (
  writes: ReadonlyArray<StorageWrite>,
): Map<number, DocumentAction> => {
  const actions = new Map<number, DocumentAction>()
  for (const write of writes) {
    if (write.type === 'document.create') {
      const action = actionFor(actions, write.record.id)
      if (action.create !== undefined || action.content !== undefined) {
        throw new Error(`Document ${write.record.id} has more than one content command`)
      }
      action.create = write.record
      action.content = write.content
    } else if (write.type === 'document.change') {
      const action = actionFor(actions, write.id)
      if (action.content !== undefined) {
        throw new Error(`Document ${write.id} has more than one content command`)
      }
      action.content = write.content
    } else if (write.type === 'document.retire') {
      const action = actionFor(actions, write.id)
      if (action.retire) throw new Error(`Document ${write.id} is retired more than once`)
      action.retire = true
    }
  }
  return actions
}

const checkAction = (
  state: State,
  id: number,
  action: DocumentAction,
): DocumentRecord | DocumentCreate => {
  const existing = state.documents.get(id)
  if (action.create === undefined && existing === undefined) {
    throw new Error(`Unknown document: ${id}`)
  }
  if (action.create !== undefined && existing !== undefined) {
    throw new Error(`Document ${id} already exists`)
  }
  if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`)
  if (action.content?.kind === 'delta') {
    const previous = existing?.revisions.at(-1)
    if (previous === undefined) throw new Error(`Document ${id} delta has no base`)
    if (previous.version !== action.content.version) {
      throw new Error(`Document ${id} version transition requires a base`)
    }
  }
  const record = action.create ?? existing?.record
  if (record === undefined) throw new Error(`Unknown document: ${id}`)
  return record
}

/** Reject actions on unknown or retired documents, and addresses left with two current incarnations. */
export const checkDocumentActions = (
  state: State,
  actions: ReadonlyMap<number, DocumentAction>,
): void => {
  const liveCounts = new Map<string, number>()
  for (const [id, action] of actions) {
    const key = recordAddressKey(checkAction(state, id, action))
    const currentId = state.documentAddresses.get(key)?.currentId
    let live = liveCounts.get(key) ?? (currentId === undefined ? 0 : 1)
    if (action.retire && currentId === id) live--
    if (action.create !== undefined && !action.retire) live++
    liveCounts.set(key, live)
  }
  for (const live of liveCounts.values()) {
    if (live > 1) throw new Error('Document address already has a current incarnation')
  }
}

const createDocument = (
  state: State,
  create: DocumentCreate,
  content: DocumentContent,
  retire: boolean,
  seq: Seq,
): StoredDocumentState => {
  // Created and retired in one commit gives an empty lifetime.
  const record: DocumentRecord = retire
    ? { ...create, createdAt: seq, retiredAt: seq }
    : { ...create, createdAt: seq }
  const stored: StoredDocumentState = { record, revisions: [{ ...content, seq }] }
  state.recordTypes.set(record.id, 'document')
  state.nextId = Math.max(state.nextId, record.id + 1)
  state.documents.set(record.id, stored)
  const address = getOrCreate(
    state.documentAddresses,
    recordAddressKey(record),
    (): DocumentAddressIndex => ({ ids: [] }),
  )
  insertSorted(address.ids, record.id)
  if (!retire) address.currentId = record.id
  insertMapId(state.documentIdsByScope, scopeKey(record.scope), record.id)
  return stored
}

const changeDocument = (stored: StoredDocumentState, content: DocumentContent, seq: Seq): void => {
  const revision: DocumentRevision = { ...content, seq }
  // Current-only documents drop the history a new base supersedes.
  if (revision.kind === 'base' && isCurrentOnly(stored.record)) stored.revisions = [revision]
  else stored.revisions.push(revision)
}

const retireDocument = (state: State, stored: StoredDocumentState, seq: Seq): void => {
  stored.record = { ...stored.record, retiredAt: seq }
  const address = state.documentAddresses.get(recordAddressKey(stored.record))
  if (address?.currentId === stored.record.id) delete address.currentId
}

/** Apply checked document actions. Nothing here may fail. */
export const applyDocumentActions = (
  state: State,
  actions: ReadonlyMap<number, DocumentAction>,
  seq: Seq,
): void => {
  for (const [id, action] of actions) {
    let stored = state.documents.get(id)
    if (action.create !== undefined && action.content !== undefined) {
      stored = createDocument(state, action.create, action.content, action.retire, seq)
    } else if (stored !== undefined) {
      if (action.content !== undefined) changeDocument(stored, action.content, seq)
      if (action.retire) retireDocument(state, stored, seq)
    }
    if (stored !== undefined && action.retire && isCurrentOnly(stored.record)) {
      stored.revisions = []
    }
  }
}
