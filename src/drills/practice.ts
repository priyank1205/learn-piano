/**
 * A practice session: a deck, an order, and the loop that keeps prompting.
 *
 * The grade runner already owns one rep (prompt, collect, settle, grade). This
 * owns the thing above it, which is the part that decides whether the app gets
 * opened tomorrow: what comes next, how fast it comes, and what happens after a
 * miss.
 *
 * **Auto-advance is the point.** The measurement is latency, so anything that
 * puts a mouse between two reps is measuring the mouse. A correct answer pauses
 * long enough to be seen and then draws the next prompt by itself, which is
 * also the only way the deck gets through 40 reps in five minutes.
 *
 * **A miss stops the loop.** It reveals the notes, offers to play them, and
 * waits. The rep is already logged as wrong and no retry can change it: the
 * pause is for looking at the answer, and the item comes back later in the same
 * session (queue.ts) to find out whether the look worked.
 *
 * **Nothing here persists.** Reps live until the page reloads. `summary()`
 * returns the shape architecture.md section 8 wants in `sessionLog`, so the
 * store slice writes it rather than inventing it. Sessions per week is the
 * metric that decides whether any of the rest matters (CLAUDE.md), and it
 * cannot be counted until that store exists.
 */

import { useSyncExternalStore } from 'react';
import { LATENCY_BANDS, runner } from '../grade/index.ts';
import type { LatencyBands, Rep } from '../grade/index.ts';
import { median } from '../stats.ts';
import { ItemQueue } from './queue.ts';
import { instantiate } from './types.ts';
import type { DrillItem } from './types.ts';
import { itemsForNodes, templateForItem } from './registry.ts';

/** The core V1 target: major triads, all three inversions (skill-tree.json). */
export const DEFAULT_DECK: readonly string[] = ['kt-inv-maj-triads'];

/**
 * How long a correct answer stays on screen before the next prompt. Long enough
 * to read the latency, short enough that a good run feels like a run. Adjustable
 * on the screen, because this is a feel number and feel numbers are wrong until
 * they have been used.
 */
export const DEFAULT_DWELL_MS = 900;

export interface PracticeRep {
  item: DrillItem;
  rep: Rep;
}

/** The `sessionLog` row this session will become once there is a store. */
export interface PracticeSummary {
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  nodeIds: readonly string[];
  reps: number;
  correct: number;
}

export interface ItemStats {
  item: DrillItem;
  reps: number;
  correct: number;
  medianLatencyMs: number | null;
}

export interface PracticeStats {
  reps: number;
  correct: number;
  accuracy: number;
  medianLatencyMs: number | null;
  /**
   * Share of CORRECT reps under the automatic band. The same statistic the tree
   * uses to call a deck complete, so it has to be computed the same way: a
   * wrong answer has no meaningful latency and must not count either side.
   */
  automaticShare: number;
  /** Slowest first. The list of what to actually work on. */
  byItem: ItemStats[];
}

export function summarise(
  reps: readonly PracticeRep[],
  bands: LatencyBands = LATENCY_BANDS
): PracticeStats {
  const correct = reps.filter((r) => r.rep.result.correct);
  const latencies = correct
    .map((r) => r.rep.result.latencyMs)
    .filter((l): l is number => l !== null);

  const groups = new Map<string, PracticeRep[]>();
  for (const r of reps) {
    const list = groups.get(r.item.itemId);
    if (list) list.push(r);
    else groups.set(r.item.itemId, [r]);
  }

  const byItem: ItemStats[] = [...groups.values()].map((group) => {
    const hits = group.filter((r) => r.rep.result.correct);
    const times = hits
      .map((r) => r.rep.result.latencyMs)
      .filter((l): l is number => l !== null);
    return {
      item: group[0]!.item,
      reps: group.length,
      correct: hits.length,
      medianLatencyMs: times.length > 0 ? median(times) : null,
    };
  });

  // A miss is slower than any latency, so items that were got wrong sort above
  // the merely slow ones. That is the order they should be worked on in.
  byItem.sort((a, b) => rank(b) - rank(a));

  return {
    reps: reps.length,
    correct: correct.length,
    accuracy: reps.length === 0 ? 0 : correct.length / reps.length,
    medianLatencyMs: latencies.length > 0 ? median(latencies) : null,
    automaticShare:
      correct.length === 0
        ? 0
        : latencies.filter((l) => l < bands.automaticMs).length / correct.length,
    byItem,
  };
}

/** Sort key for "needs work": misses first, then slowest median latency. */
function rank(s: ItemStats): number {
  if (s.correct < s.reps)
    return Number.MAX_SAFE_INTEGER - s.correct / Math.max(s.reps, 1);
  return s.medianLatencyMs ?? 0;
}

export type PracticeStatus = 'idle' | 'running';

class Practice {
  status: PracticeStatus = 'idle';
  nodeIds: readonly string[] = DEFAULT_DECK;
  current: DrillItem | null = null;
  reps: readonly PracticeRep[] = [];
  autoAdvance = true;
  dwellMs = DEFAULT_DWELL_MS;
  startedAt: number | null = null;
  endedAt: number | null = null;

  private queue: ItemQueue | null = null;
  private unsubscribeRunner: (() => void) | null = null;
  /** Identity of the last rep taken from the runner, so it is taken once. */
  private lastRecorded: Rep | null = null;
  private advanceAt: number | null = null;
  private frame: number | null = null;
  private subs = new Set<() => void>();
  private snapshot = 0;

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

  get deckSize(): number {
    return this.queue?.deck.length ?? 0;
  }

  /** Items left before every item in the deck has been seen this pass. */
  get remainingInPass(): number {
    return this.queue?.remaining ?? 0;
  }

  setAutoAdvance(on: boolean): void {
    this.autoAdvance = on;
    if (!on) this.cancelAdvance();
    this.bump();
  }

  setDwellMs(ms: number): void {
    this.dwellMs = ms;
    this.bump();
  }

  start(nodeIds: readonly string[] = this.nodeIds): void {
    this.teardown();
    const deck = itemsForNodes(nodeIds);
    this.nodeIds = [...nodeIds];
    if (deck.length === 0) {
      this.status = 'idle';
      this.bump();
      return;
    }
    this.queue = new ItemQueue(deck);
    this.reps = [];
    this.lastRecorded = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.status = 'running';
    // Subscribed only while a session runs, so reps taken on the grader bench
    // can never land in a practice log.
    this.unsubscribeRunner = runner.subscribe(() => this.onRunnerChange());
    this.next();
  }

  /** End the session. Reps and the summary stay on screen. */
  end(): void {
    if (this.status === 'idle') return;
    this.teardown();
    this.endedAt = Date.now();
    this.status = 'idle';
    this.current = null;
    this.bump();
  }

  next(): void {
    if (this.status !== 'running' || !this.queue) return;
    this.cancelAdvance();
    const item = this.queue.next();
    if (!item) {
      this.end();
      return;
    }
    this.current = item;
    runner.arm(instantiate(templateForItem(item), item));
    this.bump();
  }

  summary(): PracticeSummary {
    const startedAt = this.startedAt ?? 0;
    const endedAt = this.endedAt;
    return {
      startedAt,
      endedAt,
      durationMs: startedAt === 0 ? 0 : (endedAt ?? Date.now()) - startedAt,
      nodeIds: this.nodeIds,
      reps: this.reps.length,
      correct: this.reps.filter((r) => r.rep.result.correct).length,
    };
  }

  /**
   * Take a completed rep off the runner. Called on every runner notification,
   * which includes note-ons while answering, so it has to be cheap and it has
   * to be idempotent: `lastRecorded` is what makes the second call a no-op.
   */
  private onRunnerChange(): void {
    if (this.status !== 'running' || runner.state !== 'answered') return;
    const rep = runner.last;
    const item = this.current;
    if (!rep || !item || rep === this.lastRecorded) return;
    // A rep for something else armed the runner (the bench, a stale prompt).
    if (rep.spec.itemId !== item.itemId) return;

    this.lastRecorded = rep;
    this.reps = [...this.reps, { item, rep }];

    if (rep.result.correct) {
      if (this.autoAdvance) this.scheduleAdvance();
    } else {
      // session-generator.md section 2: an `again` comes back this session,
      // after 3 to 6 other items.
      this.queue?.requeue(item);
    }
    this.bump();
  }

  /**
   * Wait `dwellMs`, then prompt again. On animation frames rather than a timer:
   * `setInterval` is banned for anything musical (CLAUDE.md) and a background
   * tab throttles timers to one a second, which would strand the loop. Nothing
   * measured depends on when this fires, since latency is timestamped from the
   * paint of the next prompt.
   */
  private scheduleAdvance(): void {
    this.cancelAdvance();
    this.advanceAt = performance.now() + this.dwellMs;
    const tick = (now: number) => {
      if (this.advanceAt === null) return;
      if (now >= this.advanceAt) {
        this.advanceAt = null;
        this.frame = null;
        this.next();
        return;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private cancelAdvance(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.advanceAt = null;
  }

  private teardown(): void {
    this.cancelAdvance();
    this.unsubscribeRunner?.();
    this.unsubscribeRunner = null;
    runner.cancel();
  }
}

/** One practice session for the app, mirroring the single grade runner. */
export const practice = new Practice();

export function usePractice(): Practice {
  useSyncExternalStore(practice.subscribe, practice.getSnapshot, practice.getSnapshot);
  return practice;
}
