/**
 * The `Model` service over providers: each request goes to the provider its model names.
 */
import { Effect, Stream } from 'effect'
import type { DeferredHandle } from '../Message.ts'
import type { Info, Provider, Ref, Service } from '../Model.ts'
import { ModelError, Rejected, UnknownModel } from '../ModelError.ts'

const unknown = (ref: Ref) =>
  new ModelError({
    message: `Model ${ref.provider}/${ref.modelId} is not available`,
    reason: new UnknownModel(ref),
  })

const unsupported = (model: Info) =>
  new ModelError({
    message: `Provider ${model.provider} does not support deferred responses`,
    reason: new Rejected({}),
  })

export const make = (providers: Iterable<Provider>): Service => {
  // A later provider of the same name replaces an earlier one.
  const byName = new Map<string, Provider>()
  for (const provider of providers) byName.set(provider.name, provider)
  const all = [...byName.values()].flatMap((provider) => provider.models)

  const find = (ref: Ref): readonly [Provider, Info] | undefined => {
    const provider = byName.get(ref.provider)
    const model = provider?.models.find((candidate) => candidate.id === ref.modelId)
    return provider === undefined || model === undefined ? undefined : [provider, model]
  }
  const resolved = (ref: Ref) => {
    const found = find(ref)
    return found === undefined ? Effect.fail(unknown(ref)) : Effect.succeed(found)
  }
  return {
    models: all,
    info: (ref) => find(ref)?.[1],
    stream: (request) =>
      Stream.unwrap(
        Effect.map(resolved(request.model), ([provider, model]) => provider.stream(request, model)),
      ),
    poll: (ref, handle: DeferredHandle) =>
      Effect.flatMap(resolved(ref), ([provider, model]) =>
        provider.poll === undefined
          ? Effect.fail(unsupported(model))
          : provider.poll(handle, model),
      ),
    cancel: (ref, handle) =>
      Effect.flatMap(resolved(ref), ([provider, model]) =>
        provider.cancel === undefined ? Effect.void : provider.cancel(handle, model),
      ),
  }
}
