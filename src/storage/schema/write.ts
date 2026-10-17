import { Schema } from 'effect'
import { ConversationRecord } from './conversation.ts'
import { DocumentBase, DocumentContent, DocumentCopySource, DocumentCreate } from './document.ts'
import { EntryRecord } from './entry.ts'
import { DocumentId } from './ids.ts'
import { SubmissionRecord } from './submission.ts'
import { TaskRecord } from './task.ts'

/** One record or document mutation in an atomic storage commit. */
export const StorageWrite = Schema.Union([
  Schema.Struct({ type: Schema.Literal('conversation'), value: ConversationRecord }),
  Schema.Struct({ type: Schema.Literal('entry'), value: EntryRecord }),
  Schema.Struct({ type: Schema.Literal('task'), value: TaskRecord }),
  Schema.Struct({ type: Schema.Literal('submission'), value: SubmissionRecord }),
  Schema.Struct({
    type: Schema.Literal('document.create'),
    record: DocumentCreate,
    content: DocumentBase,
  }),
  Schema.Struct({
    type: Schema.Literal('document.copy'),
    record: DocumentCreate,
    source: DocumentCopySource,
  }),
  Schema.Struct({
    type: Schema.Literal('document.change'),
    id: DocumentId,
    content: DocumentContent,
  }),
  Schema.Struct({ type: Schema.Literal('document.retire'), id: DocumentId }),
])
export type StorageWrite = typeof StorageWrite.Type
