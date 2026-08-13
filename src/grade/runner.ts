/**
 * The live loop around the grader: show a prompt, collect what is played,
 * decide when the answer is in, grade it.
 *
 * Three things here are not obvious.
 *
 * **`promptReadyAt` is measured after paint, not at render.** Latency is
 * measured from when the user could *see* the prompt (architecture.md section
 * 5). React returning from a render is not that moment. Two nested animation
 * frames is the standard approximation of "the frame containing this update has
 * been handed to the compositor"; it errs a frame early, which overstates
 * latency slightly rather than flattering it.
 *
 * **No timer drives the settle deadline.** A `setInterval` is banned for
 * anything musical (CLAUDE.md) and Chrome throttles timers to one per second in
 * a background tab, which would turn a 300ms settle into a 1000ms one. The
 * deadline is checked on animation frames instead.
 *
 * **Nothing measured depends on when the check fires.** Every number in the
 * result comes from MIDI event timestamps, so a late frame delays the feedback
 * appearing and cannot change the latency, the spread, or the grade. The only
 * clock reading is "has the settle window passed yet", and that is monotonic.
 */

import { useSyncExternalStore } from 'react';
import { midi } from '../midi.ts';
import type { NormalizedEvent } from '../midi.ts';
import { gradeSet, settledAnswer } from './set.ts';
import { withTolerances } from './types.ts';
import type { DrillInstance, GradeResult } from './types.ts';

/** A prompt before it has been shown: `promptReadyAt` is the runner's to fill. */
export type PendingPrompt = Omit<DrillInstance, 'promptReadyAt'>;

export type RunnerState =
  /** Nothing prompted. */
  | 'idle'
  /** Prompt rendered, waiting for paint to timestamp it. */
  | 'arming'
  /** Prompt is up; the user is answering. */
  | 'waiting'
  /** Graded. The result is on `last`. */
  | 'answered';

export interface Rep {
  spec: DrillInstance;
  result: GradeResult;
}

class GradeRunner {
  state: RunnerState = 'idle';
  spec: DrillInstance | null = null;
  last: Rep | null = null;

  /**
   * Every rep since the page loaded. Persistence arrives with the store slice.
   *
   * Replaced rather than mutated on each rep. This is a `useSyncExternalStore`
   * snapshot, so anything derived from it with `useMemo` compares the array by
   * identity: pushing in place re-renders the panel with a stale summary, which
   * looks exactly like the stats being broken.
   */
  history: readonly Rep[] = [];

  private events: NormalizedEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private frame: number | null = null;
  private subs = new Set<() => void>();
  private snapshot = 0;
  /** Identifies the current arm, so a superseded one cannot land two frames late. */
  private armToken = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  getSnapshot = (): number => this.snapshot;

  private bump(): void {
    this.snapshot += 1;
    for (const fn of this.subs) fn();
  }

  /** Events collected for the current prompt, for the bench's cluster panel. */
  collected(): readonly NormalizedEvent[] {
    return this.events;
  }

  /**
   * Show a prompt. Collection starts immediately so nothing is missed, and the
   * grader discards whatever arrived before `promptReadyAt`.
   */
  arm(prompt: PendingPrompt): void {
    this.stopWatching();
    this.events = [];
    this.spec = null;
    this.last = null;
    this.state = 'arming';
    this.armToken += 1;
    const token = this.armToken;
    this.bump();

    this.unsubscribe = midi.subscribe((e) => this.onEvent(e));

    requestAnimationFrame(() => {
      requestAnimationFrame((paintedAt) => {
        if (token !== this.armToken || this.state !== 'arming') return;
        this.spec = { ...prompt, promptReadyAt: paintedAt };
        this.state = 'waiting';
        this.bump();
        this.watch();
      });
    });
  }

  /** Abandon the current prompt without grading it. */
  cancel(): void {
    this.stopWatching();
    this.state = 'idle';
    this.spec = null;
    this.events = [];
    this.bump();
  }

  /**
   * Grade now, whatever is on the keyboard. This is the "I don't know" button:
   * with nothing played it records a miss, which is the honest rating for it.
   *
   * Grading with `nowMs` at Infinity rather than the current time because a
   * forced submit declares the rep over: a chord played 50ms ago has not
   * settled yet, and should still count as the answer rather than as silence.
   */
  submit(): void {
    if (!this.spec || this.state !== 'waiting') return;
    this.finish(Infinity);
  }

  private onEvent(event: NormalizedEvent): void {
    if (this.state !== 'waiting' && this.state !== 'arming') return;
    this.events.push(event);
    // Held notes and releases are worth seeing on screen while answering.
    if (event.type === 'on') this.bump();
  }

  /**
   * Poll the settle condition on animation frames. The predicate is the same
   * `settledAnswer` the grader uses, so the runner can never grade a rep the
   * grader would consider unfinished.
   */
  private watch(): void {
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      if (this.state !== 'waiting' || !this.spec) return;
      const nowMs = performance.now();
      if (settledAnswer(this.events, this.spec, { nowMs })) this.finish(nowMs);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopWatching(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private finish(nowMs: number): void {
    const spec = this.spec;
    if (!spec) return;
    this.stopWatching();
    const result = gradeSet(this.events, spec, { nowMs });
    const rep: Rep = { spec, result };
    this.last = rep;
    this.history = [...this.history, rep];
    this.state = 'answered';
    this.bump();
  }

  /** Milliseconds until the current answer settles, for the on-screen countdown. */
  settleRemainingMs(nowMs: number): number | null {
    if (this.state !== 'waiting' || !this.spec) return null;
    let lastOnTs: number | null = null;
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const e = this.events[i]!;
      // Notes struck before the prompt appeared are not part of the answer, so
      // they must not start a countdown that will never resolve.
      if (e.type === 'on' && e.ts >= this.spec.promptReadyAt) {
        lastOnTs = e.ts;
        break;
      }
    }
    if (lastOnTs === null) return null;
    const tol = withTolerances(this.spec.grading.tolerances);
    return Math.max(0, lastOnTs + tol.settleMs - nowMs);
  }

  resetHistory(): void {
    this.history = [];
    this.bump();
  }
}

export const runner = new GradeRunner();

export function useGradeRunner(): GradeRunner {
  useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  return runner;
}
