/**
 * The registry's state: accounts saved under one key of the `KeyValueStore`, their providers in a
 * `SubscriptionRef`, and changes to both one at a time.
 */
import { Effect, Option, Schema, Semaphore, SubscriptionRef } from 'effect'
import type { Context } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Credentials } from 'effect-harness/credentials'
import type { Model } from 'effect-harness/model'
import { Account, AccountError } from '../../shared/Account.ts'
import type { Status } from '../../shared/Account.ts'
import type { Options, Requires } from '../Accounts.ts'
import * as providers from './providers.ts'

const KEY = 'accounts'
const Saved = Schema.Array(Account)

export interface Registered {
  readonly account: Account
  readonly provider: Model.Listable<Requires>
}

export interface State {
  readonly options: Options
  readonly store: KeyValueStore.SchemaStore<typeof Saved>
  readonly credentials: Credentials.Service
  /** What the providers answer with. */
  readonly context: Context.Context<Requires>
  readonly live: SubscriptionRef.SubscriptionRef<ReadonlyArray<Registered>>
  readonly line: Semaphore.Semaphore
}

export const failed =
  (what: string) =>
  (cause: { readonly message: string }): AccountError =>
    new AccountError({ message: `${what}: ${cause.message}` })

export const registered = (account: Account, options: Options): Registered => ({
  account,
  provider: providers.of(account, options),
})

/** Open the registry over the saved accounts. */
export const open = Effect.fnUntraced(function* (options: Options) {
  const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, Saved)
  const saved = yield* store
    .get(KEY)
    .pipe(
      Effect.map(Option.getOrElse((): ReadonlyArray<Account> => [])),
      Effect.mapError(failed('The saved accounts could not be read')),
    )
  const state: State = {
    options,
    store,
    credentials: yield* Credentials.Credentials,
    context: yield* Effect.context<Requires>(),
    live: yield* SubscriptionRef.make<ReadonlyArray<Registered>>(
      saved.map((account) => registered(account, options)),
    ),
    line: yield* Semaphore.make(1),
  }
  return state
})

export const current = (state: State) => SubscriptionRef.get(state.live)

export const lookup = (state: State, name: string) =>
  Effect.map(current(state), (all) => all.find(({ account }) => account.name === name)?.account)

/** Change the registry under the lock, saving the accounts before the providers change. */
export const change = <E>(
  state: State,
  f: (all: ReadonlyArray<Registered>) => Effect.Effect<ReadonlyArray<Registered>, E>,
) =>
  Semaphore.withPermit(
    state.line,
    current(state).pipe(
      Effect.flatMap(f),
      Effect.tap((next) =>
        state.store
          .set(
            KEY,
            next.map(({ account }) => account),
          )
          .pipe(Effect.mapError(failed('The accounts could not be saved'))),
      ),
      Effect.flatMap((next) => SubscriptionRef.set(state.live, next)),
    ),
  )

/** Register `account`, replacing one of its name only when `replace` allows it. */
export const register = (state: State, account: Account, replace: (found: Account) => boolean) =>
  change(state, (all) => {
    const found = all.find((entry) => entry.account.name === account.name)
    if (found !== undefined && !replace(found.account)) {
      return Effect.fail(new AccountError({ message: `${account.name} is already registered` }))
    }
    const others = all.filter((entry) => entry.account.name !== account.name)
    return Effect.succeed([...others, registered(account, state.options)])
  })

/** `accounts` with whether each one's credential is stored. */
export const statuses = (state: State, accounts: ReadonlyArray<Account>) =>
  state.credentials.list.pipe(
    Effect.mapError(failed('The credential store failed')),
    Effect.map((stored) =>
      accounts.map((account): Status => ({
        ...account,
        signedIn: stored.some(({ provider }) => provider === account.name),
      })),
    ),
  )

export const statusOf = (state: State, account: Account) =>
  Effect.map(statuses(state, [account]), (found) => found[0] ?? { ...account, signedIn: false })
