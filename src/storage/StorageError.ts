import { Schema } from 'effect'

/**
 * Storage failed: a rejected commit, an exhausted ID space, corrupt state, a closed backend, or a
 * backend I/O failure. Unlike `StorageRequestError` it is fatal to the Session, which nothing
 * retries, so a backend retries transient failures itself before failing with it.
 */
export class StorageError extends Schema.TaggedError<
  StorageError,
  { readonly brand: unique symbol }
>()('StorageError', { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }) {}
