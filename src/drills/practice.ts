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
 * **Two modes, one loop.** In `scheduled` mode what comes next is the softmax
 * selection of session-generator.md section 4, over the items that are actually
 * due. In `free` mode the user has picked decks by hand and gets the shuffled
 * cycle of `queue.ts`, which is right for a deck and wrong for a due pool.
 *
 * Reps persist in both. A deliberately drilled item is a real rep whichever way
 * it was chosen, and it updates the schedule identically. (The one thing that
 * does not is section 8's free-play HUD harvest, which is passive telemetry,
 * updates `latEMA` only, and does not exist yet.)
 */

import { useSyncExternalStore } from 'react';
import { LATENCY_BANDS, runner } from '../grade/index.ts';
import type { LatencyBands, Rep } from '../grade/index.ts';
import { median } from '../stats.ts';
import { ItemQueue } from './queue.ts';
import type { DrillItem } from './types.ts';
import { itemById, itemsForNodes } from './registry.ts';
import { presentItem, stopPresentation } from './present.ts';
import { store } from '../store/store.ts';
import type { ReturnMode } from '../store/types.ts';
import { SessionPlanner, deriveProgress } from '../schedule/index.ts';
import type { NodeProgress, PlannedItem } from '../schedule/index.ts';

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

/**
 * The `sessionLog` row this session becomes. The store writes this shape rather
 * than inventing one; `SessionRow` adds only the fields the store owns (its id,
 * the return mode, the rolling accuracy across sessions).
 */
export interface PracticeSummary {
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  mode: PracticeMode;
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

export type PracticeStatus = 'idle' | 'starting' | 'running';

export type PracticeMode = 'scheduled' | 'free';

/**
 * Why the loop stopped handing out items. `exhausted` is a real, healthy state
 * and the screen says so plainly: the due pool is a set of dates and the new
 * item faucet is a daily allowance, so "nothing more today" is the scheduler
 * working rather than the app breaking.
 */
export type PracticeEnd = 'exhausted' | 'ended' | null;

/**
 * The pool a scheduled session draws from: every item of every node in play,
 * plus every item that already has state.
 *
 * The second half is what keeps section 1.3's promise that a completed node's
 * items "stay in SRS forever". A node that leaves the active set by completing
 * would otherwise take its whole deck out of circulation, and the first thing
 * the user would notice is the material he has just mastered rotting.
 */
export function scheduledPool(
  activeNodeIds: readonly string[],
  stateIds: Iterable<string>
): DrillItem[] {
  const seen = new Map<string, DrillItem>();
  for (const item of itemsForNodes(activeNodeIds)) seen.set(item.itemId, item);
  for (const itemId of stateIds) {
    const item = itemById(itemId);
    if (item) seen.set(item.itemId, item);
  }
  return [...seen.values()];
}

class Practice {
  status: PracticeStatus = 'idle';
  mode: PracticeMode = 'scheduled';
  nodeIds: readonly string[] = DEFAULT_DECK;
  current: DrillItem | null = null;
  reps: readonly PracticeRep[] = [];
  autoAdvance = true;
  dwellMs = DEFAULT_DWELL_MS;
  startedAt: number | null = null;
  endedAt: number | null = null;
  endedBecause: PracticeEnd = null;

  /** Scheduled mode only. Null in free practice. */
  planner: SessionPlanner | null = null;
  active: readonly NodeProgress[] = [];
  returnMode: ReturnMode = 'normal';
  budgetMin: number | null = null;
  /** Why the current item was chosen, for the scheduler panel. */
  reason: PlannedItem['reason'] | null = null;

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
    return this.queue?.deck.length ?? this.planner?.dueCount ?? 0;
  }

  /** Items left before every item in the deck has been seen this pass. */
  get remainingInPass(): number {
    return this.queue?.remaining ?? 0;
  }

  /** Due items the planner was allowed to serve, after backlog compression. */
  get dueCount(): number {
    return this.planner?.dueCount ?? 0;
  }

  /** New items this session may still introduce, from the daily faucet. */
  get newItemsLeft(): number {
    return this.planner?.newItemsLeft ?? 0;
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

  /**
   * Free practice: a deck chosen by hand, in a shuffled cycle. Still logged,
   * still schedules; only the choice of what comes next is the user's.
   */
  async start(nodeIds: readonly string[] = this.nodeIds): Promise<void> {
    this.teardown();
    const deck = itemsForNodes(nodeIds);
    this.nodeIds = [...nodeIds];
    if (deck.length === 0) {
      this.status = 'idle';
      this.bump();
      return;
    }
    this.status = 'starting';
    this.mode = 'free';
    this.planner = null;
    this.queue = new ItemQueue(deck);
    this.budgetMin = null;
    this.bump();

    await store.load();
    await store.startSession({ mode: 'free', nodeIds, budgetMin: null });
    this.begin();
  }

  /**
   * A scheduled session: the active set decides which nodes are in play, the
   * SRS decides which of their items are due, and softmax decides the order.
   */
  async startScheduled(budgetMin?: number): Promise<void> {
    this.teardown();
    this.status = 'starting';
    this.mode = 'scheduled';
    this.queue = null;
    this.bump();

    await store.load();
    const now = Date.now();
    const { progress, active } = deriveProgress(store.itemState, {
      bands: store.settings.latencyBandsMs,
      completedAt: store.completedAt,
      satisfiedRequires: store.settings.hasPedal ? ['pedal'] : [],
      // The ear deck's threshold is a rolling window over recent reps rather
      // than a per-item count (architecture.md section 7).
      reps: store.recentReps,
    });

    const nodeIds = active.map((a) => a.nodeId);
    const returnMode = store.returnModeNow(now);
    // section 7: a gap auto-presets the shorter session. The return session is
    // meant to be the easiest one there is, and the budget is half of that.
    const budget =
      budgetMin ??
      (returnMode === 'normal'
        ? store.defaultBudgetMin(now)
        : store.settings.lateBudgetMin);

    const planner = new SessionPlanner({
      now,
      pool: scheduledPool(nodeIds, store.itemState.keys()),
      states: store.itemState,
      progress,
      returnMode,
      budgetMin: budget,
      temperature: store.settings.selectionTemperature,
      newItemsAllowed: store.newItemsLeftToday(now),
      rollingAccuracy: store.rollingAccuracy(),
      yesterdayAccuracy: store.yesterdayAccuracy(now),
    });

    // The backlog compressor pushed these out. Written before the session
    // starts, silently, with no penalty and nothing on screen (section 7).
    await store.putItemStates(planner.postponed);

    this.planner = planner;
    this.active = active;
    this.returnMode = returnMode;
    this.budgetMin = budget;
    this.nodeIds = nodeIds;

    await store.startSession({
      mode: 'scheduled',
      nodeIds,
      budgetMin: budget,
      returnMode,
      now,
    });
    this.begin();
  }

  private begin(): void {
    this.reps = [];
    this.lastRecorded = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.endedBecause = null;
    this.status = 'running';
    // Subscribed only while a session runs, so reps taken on the grader bench
    // can never land in a practice log.
    this.unsubscribeRunner = runner.subscribe(() => this.onRunnerChange());
    this.next();
  }

  /** End the session. Reps and the summary stay on screen. */
  end(why: Exclude<PracticeEnd, null> = 'ended'): void {
    if (this.status === 'idle') return;
    this.teardown();
    this.endedAt = Date.now();
    this.endedBecause = why;
    this.status = 'idle';
    this.current = null;
    this.reason = null;
    void this.closeSession();
    this.bump();
  }

  /**
   * Close the row and stamp any node that reached its threshold during the
   * session. Section 1.3's "threshold met once" is the single bit of the
   * derived layer that is not a function of the present state, so it is the
   * single bit that gets written down.
   */
  private async closeSession(): Promise<void> {
    await store.endSession();
    const { progress } = deriveProgress(store.itemState, {
      bands: store.settings.latencyBandsMs,
      completedAt: store.completedAt,
      satisfiedRequires: store.settings.hasPedal ? ['pedal'] : [],
      // The ear deck's threshold is a rolling window over recent reps rather
      // than a per-item count (architecture.md section 7).
      reps: store.recentReps,
    });
    const met = [...progress.values()].filter((p) => p.complete).map((p) => p.nodeId);
    await store.markComplete(met);
  }

  next(): void {
    if (this.status !== 'running') return;
    this.cancelAdvance();
    // Whatever the last prompt started (a metronome) stops before the next one.
    stopPresentation();

    const planned = this.planner ? this.planner.next() : null;
    const item = this.planner ? (planned?.item ?? null) : (this.queue?.next() ?? null);
    if (!item) {
      this.end(this.planner ? 'exhausted' : 'ended');
      return;
    }
    this.reason = planned?.reason ?? null;
    // The prepared item, not the pool item: an ear prompt is asked in a key
    // drawn for this rep, and the screen has to show the rep that was played.
    // Ids and nodes are the pool's, so the log and the SRS are unaffected.
    this.current = presentItem(item);
    this.bump();
  }

  summary(): PracticeSummary {
    const startedAt = this.startedAt ?? 0;
    const endedAt = this.endedAt;
    return {
      startedAt,
      endedAt,
      durationMs: startedAt === 0 ? 0 : (endedAt ?? Date.now()) - startedAt,
      mode: this.mode,
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
    this.bump();
    void this.persist(item, rep);
  }

  /**
   * Write the rep, then act on it.
   *
   * The order matters in one direction only: the planner's in-session re-queue
   * and the next selection both read state the store has just written, so
   * advancing before the write resolves would sample from a stale due pool and
   * could hand back the item that was just answered. The dwell is started after
   * the await for the same reason, which delays the next prompt by the length
   * of one IndexedDB write and changes no measurement: latency is timestamped
   * from the paint of the prompt, not from here.
   */
  private async persist(item: DrillItem, rep: Rep): Promise<void> {
    const { row } = await store.recordRep({ item, rep });

    if (this.planner) {
      this.planner.record(item.itemId, row.rating);
    } else if (!rep.result.correct) {
      // Free practice keeps the same rule through the deck's own queue
      // (section 2: an `again` comes back this session, after 3 to 6 others).
      this.queue?.requeue(item);
    }

    // A superseded rep must not advance a loop that has moved on or stopped.
    if (this.status !== 'running' || rep !== this.lastRecorded) return;
    if (rep.result.correct && this.autoAdvance) this.scheduleAdvance();
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
    stopPresentation();
    runner.cancel();
  }
}

/** One practice session for the app, mirroring the single grade runner. */
export const practice = new Practice();

export function usePractice(): Practice {
  useSyncExternalStore(practice.subscribe, practice.getSnapshot, practice.getSnapshot);
  return practice;
}
