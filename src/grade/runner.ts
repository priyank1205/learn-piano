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
 * clock reading is "has the rep finished yet", and that is monotonic.
 *
 * Slice 6 added two things and took one away.
 *
 * **The runner no longer knows which grader it is holding.** It looks one up
 * from `spec.grading.graderId` for both grading and for deciding the rep is
 * over. Waiting for a chord to settle is right for a flashcard and wrong for a
 * pulse drill, where the rep ends when the grid runs out whether or not anything
 * was played, and that difference is grader knowledge (`Grader.isFinished`).
 *
 * **A prompt can take time to deliver.** architecture.md section 5 is explicit
 * that `promptReadyAt` is "end of audio playback for ear prompts", because
 * latency must never include listening time. A `Presenter` is how a caller says
 * so: it is handed the paint timestamp, delivers the prompt, and returns the
 * instant the user could first have answered.
 */

import { useSyncExternalStore } from 'react';
import { midi } from '../midi.ts';
import type { NormalizedEvent } from '../midi.ts';
import { graderFor } from './graders.ts';
import { withTolerances } from './types.ts';
import type { DrillInstance, GradeResult } from './types.ts';

/** A prompt before it has been shown: `promptReadyAt` is the runner's to fill. */
export type PendingPrompt = Omit<DrillInstance, 'promptReadyAt'>;

/**
 * Deliver a prompt that is not simply on screen, and say when it was ready.
 *
 * Given the paint timestamp, returns the moment the answer could first have
 * begun, on the MIDI clock. An ear prompt plays two notes and returns the end of
 * playback; anything visual has nothing to do and needs no presenter at all.
 */
export type Presenter = (paintedAt: number) => number | Promise<number>;

export type RunnerState =
  /** Nothing prompted. */
  | 'idle'
  /** Prompt rendered, waiting for paint to timestamp it. */
  | 'arming'
  /** Painted, and the prompt is still being delivered. Ear drills only. */
  | 'presenting'
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
   *
   * With a `present` callback the prompt is delivered after the paint and the
   * clock starts when that finishes, which is what an ear prompt needs: notes
   * struck while the prompt is still playing land before `promptReadyAt` and are
   * discarded the same way notes struck before the prompt appeared are.
   */
  arm(prompt: PendingPrompt, present?: Presenter): void {
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
        if (!present) {
          this.begin(prompt, paintedAt, token);
          return;
        }
        this.state = 'presenting';
        this.bump();
        void Promise.resolve(present(paintedAt)).then(
          (readyAt) => this.begin(prompt, readyAt, token),
          // A prompt that cannot be delivered (audio not started, a device gone)
          // still has to leave the loop somewhere it can move on from, so the
          // rep opens at the paint and the user can submit or skip it.
          () => this.begin(prompt, paintedAt, token)
        );
      });
    });
  }

  /** The clock starts here: the prompt is up and the answer is being waited for. */
  private begin(prompt: PendingPrompt, readyAt: number, token: number): void {
    if (token !== this.armToken) return;
    if (this.state !== 'arming' && this.state !== 'presenting') return;
    this.spec = { ...prompt, promptReadyAt: readyAt };
    this.state = 'waiting';
    this.bump();
    this.watch();
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
    if (this.state === 'idle' || this.state === 'answered') return;
    this.events.push(event);
    // Held notes and releases are worth seeing on screen while answering.
    if (event.type === 'on') this.bump();
  }

  /**
   * Poll the finish condition on animation frames. The predicate belongs to the
   * grader that will do the grading, so the runner can never close a rep that
   * grader would consider unfinished.
   */
  private watch(): void {
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      if (this.state !== 'waiting' || !this.spec) return;
      const nowMs = performance.now();
      const grader = graderFor(this.spec.grading.graderId);
      if (grader.isFinished(this.events, this.spec, { nowMs })) this.finish(nowMs);
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
    const result = graderFor(spec.grading.graderId).grade(this.events, spec, { nowMs });
    const rep: Rep = { spec, result };
    this.last = rep;
    this.history = [...this.history, rep];
    this.state = 'answered';
    this.bump();
  }

  /**
   * Milliseconds until the current answer settles, for the on-screen countdown.
   * Untimed drills only: a timed rep is not waiting for silence, it is waiting
   * for the grid to run out, and there is nothing to count down to.
   */
  settleRemainingMs(nowMs: number): number | null {
    if (this.state !== 'waiting' || !this.spec) return null;
    // "tempoBpm present => timed grading" (architecture.md section 2).
    if (this.spec.expected.tempoBpm !== undefined) return null;
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
