import { Schema } from 'effect'

/**
 * A storage read rejected an invalid request, such as an unknown conversation or a cursor from
 * another scan, with no durable effect. It fails only that read.
 */
export class StorageRequestError extends Schema.TaggedError<
  StorageRequestError,
  { readonly brand: unique symbol }
>()('StorageRequestError', { message: Schema.String }) {}
