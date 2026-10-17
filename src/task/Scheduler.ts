/**
 * The task `Scheduler`, ported from pi's `harness/scheduler.ts`.
 *
 * It reserves runnable tasks on the Session line, runs each one's phase handlers in an invocation
 * fiber off the line, and decides on the line, before every phase, whether the invocation goes on:
 *
 * 1. a task that is no longer running (terminal or waiting) stops;
 * 2. a closing Scheduler stops, keeping the checkpoint for the next one;
 * 3. an abort-marked task stops, and its abort handler runs in a fresh invocation;
 * 4. a failed or defective handler faults the task;
 * 5. a changed checkpoint runs the next phase, or hands over to a replacement definition;
 * 6. an unchanged checkpoint faults the task: the phase made no durable progress.
 *
 * Opening moves every task a crash left `running` back to `pending`. A task whose definition is
 * missing, older than the record, or fails to migrate stays live and blocked until the registry
 * changes; aborting it settles it as `orphaned`. Closing the scope interrupts every invocation and
 * writes no outcome, so the work resumes in the next Scheduler.
 *
 * Not ported yet: task ownership (completing holds, abort cascades, `failFast` marks), idle waits,
 * conversation aborts, `abandonOnRestart`, and inspection.
 */
import { Context, Layer } from 'effect'
import type { Effect, Scope } from 'effect'
import type { CommitError, Session } from '../session/Session.ts'
import type { Storage } from '../storage/Storage.ts'
import type { TaskId } from '../storage/schema/Ids.ts'
import * as internal from './internal/scheduler.ts'
import type { Registry } from './Registry.ts'
import type { TerminalTask } from './Task.ts'
import type { SchedulerClosed, TaskNotFound } from './TaskError.ts'

export interface Service {
  /**
   * Commit the task's abort mark, interrupt its run invocation and wait for it to end; the abort
   * handler then runs in a fresh invocation. A task no definition can take is settled as
   * `orphaned` instead. `terminal` when the task had already ended.
   */
  readonly abort: (id: TaskId) => Effect.Effect<'marked' | 'terminal', TaskNotFound | CommitError>
  /** Wait for the task's terminal receipt. Interrupting the wait leaves the task running. */
  readonly waitForTask: (
    id: TaskId,
  ) => Effect.Effect<TerminalTask, TaskNotFound | SchedulerClosed | CommitError>
}

export class Scheduler extends Context.Service<Scheduler, Service>()(
  'effect-harness/task/Scheduler',
) {}

/**
 * Open a Scheduler over the Session and Registry in context and start scheduling. It reads
 * committed records from the Session's `Storage` on the line. Closing the scope stops it.
 */
export const make: Effect.Effect<Service, CommitError, Session | Storage | Registry | Scope.Scope> =
  internal.make

/** A `Scheduler` over the provided Session, its Storage, and a Registry. */
export const layer: Layer.Layer<Scheduler, CommitError, Session | Storage | Registry> =
  Layer.effect(Scheduler, make)
