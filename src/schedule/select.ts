/**
 * What comes next (session-generator.md sections 3, 4 and 7).
 *
 * ```
 * duePool   = items with dueAt <= now, status != suspended
 * priority(item) = sqrt(overdueDays + 1) * nodeWeight * leechShadow
 * selection = softmax-weighted sampling over priority, temperature 0.7
 * ```
 *
 * The sampling is the point, and section 9 says why: "same items forever" is a
 * named failure mode, and strict priority order is how it happens. Softmax
 * keeps the ordering meaningful without making it deterministic.
 *
 * This replaces the shuffled cycle in `drills/queue.ts` as the source of what
 * comes next. That cycle still exists and is still right for what it does: free
 * practice, where the user has picked a deck by hand and wants to go through
 * it. A due pool is not a deck, and shuffling it would discard every scheduling
 * decision the SRS just made.
 */

import type { DrillItem } from '../drills/types.ts';
import type { ItemState, ReturnMode } from '../store/types.ts';
import type { NodeProgress } from './mastery.ts';
import { itemNodeWeight } from './mastery.ts';
import { DAY_MS } from '../store/weeks.ts';
import { inSchedule, intervalCapDays } from './srs.ts';
import type { Rng } from './srs.ts';

/** section 4: still served, less often. */
export const LEECH_SHADOW_LAPSES = 5;
export const LEECH_SHADOW = 0.5;

/** section 4's variety guard: an item appears at most twice per session. */
export const MAX_SERVES_PER_SESSION = 2;

/** section 2's in-session re-queue: a miss returns after this many other items. */
export const REQUEUE_GAP: readonly [number, number] = [3, 6];

/** section 6: up to 20% of a block's items may be new. */
export const NEW_ITEM_SHARE = 0.2;

/** section 3's load guard, and section 9's faucet pause. */
export const LOAD_GUARD_ACCURACY = 0.75;
export const FAUCET_PAUSE_ACCURACY = 0.7;

/** section 7: serve at most this multiple of one session's capacity. */
export const BACKLOG_FACTOR = 1.5;

/**
 * Reps a minute, for turning a budget in minutes into a session capacity. A
 * flashcard rep is a prompt, a chord and a beat of feedback; eight a minute is
 * seven and a half seconds each. A guess, and the first thing to replace with
 * the measured value once there are sessions to measure.
 */
export const REPS_PER_MINUTE = 8;

export const sessionCapacity = (budgetMin: number): number =>
  Math.max(1, Math.round(budgetMin * REPS_PER_MINUTE));

export function overdueDays(state: ItemState, now: number): number {
  return Math.max(0, (now - state.dueAt) / DAY_MS);
}

export function leechShadow(state: ItemState): number {
  return state.lapses >= LEECH_SHADOW_LAPSES ? LEECH_SHADOW : 1;
}

export function priority(
  state: ItemState,
  now: number,
  progress: ReadonlyMap<string, NodeProgress>
): number {
  return (
    Math.sqrt(overdueDays(state, now) + 1) *
    itemNodeWeight(state.nodeIds, progress) *
    leechShadow(state)
  );
}

/**
 * Softmax-weighted sampling, temperature 0.7.
 *
 * The max is subtracted before exponentiating. Priorities here are small enough
 * that it never overflows in practice, but a temperature the user can lower is
 * a divisor that can approach zero, and `exp(3 / 0.01)` is `Infinity`, which
 * turns the whole distribution into `NaN` and picks nothing.
 */
export function softmaxPick<T>(
  candidates: readonly T[],
  weightOf: (c: T) => number,
  rng: Rng,
  temperature: number
): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const t = Math.max(temperature, 1e-6);
  const scores = candidates.map((c) => weightOf(c) / t);
  const max = Math.max(...scores);
  const weights = scores.map((s) => Math.exp(s - max));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return candidates[Math.floor(rng() * candidates.length)]!;
  }

  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}

export interface BacklogResult {
  /** Item ids that may be served this session. */
  serve: Set<string>;
  /** States pushed out, already updated. The store writes these. */
  postponed: ItemState[];
}

/**
 * section 7, the 1-to-3-day gap: "serve at most 1.5 x session capacity due
 * items; silently postpone the rest by extending their interval by the overdue
 * amount (no penalty, no message)".
 *
 * Silently is the operative word. The postponed items get no lapse, no ease
 * change and nothing on screen. This is the mechanism that stops a four-day gap
 * from presenting as a wall, which section 7 calls the failure pattern that
 * ends self-built tools.
 */
export function compressBacklog(
  due: readonly { item: DrillItem; state: ItemState }[],
  capacity: number,
  now: number,
  progress: ReadonlyMap<string, NodeProgress>
): BacklogResult {
  const limit = Math.ceil(capacity * BACKLOG_FACTOR);
  if (due.length <= limit) {
    return { serve: new Set(due.map((d) => d.item.itemId)), postponed: [] };
  }

  const ranked = [...due].sort(
    (a, b) => priority(b.state, now, progress) - priority(a.state, now, progress)
  );
  const serve = new Set(ranked.slice(0, limit).map((d) => d.item.itemId));
  const postponed = ranked.slice(limit).map(({ state }) => {
    const over = overdueDays(state, now);
    const cap = intervalCapDays(state.nodeIds);
    const extra = Math.min(Math.max(over, 1), cap);
    return {
      ...state,
      intervalDays: Math.min(cap, state.intervalDays + extra),
      dueAt: now + extra * DAY_MS,
      updatedAt: now,
    };
  });
  return { serve, postponed };
}

export interface PlannerOptions {
  now: number;
  /** Every item from the nodes in play, plus anything with existing state. */
  pool: readonly DrillItem[];
  states: ReadonlyMap<string, ItemState>;
  progress: ReadonlyMap<string, NodeProgress>;
  returnMode: ReturnMode;
  /** Session budget in minutes, for the backlog cap. */
  budgetMin: number;
  temperature: number;
  /** Remaining allowance from the daily faucet. */
  newItemsAllowed: number;
  /** Rolling accuracy over the last 30 graded reps. Null before there are any. */
  rollingAccuracy: number | null;
  /** Yesterday's session accuracy, for the load guard. Null if there was none. */
  yesterdayAccuracy: number | null;
  rng?: Rng;
}

export interface PlannedItem {
  item: DrillItem;
  state: ItemState | null;
  /** Why this item, for the scheduler panel. */
  reason: 'due' | 'new' | 'learning';
}

/**
 * One session's selection state: what is due, what has been served, and which
 * misses are waiting to come back.
 *
 * A class rather than a function because two of section 4's rules are about the
 * session rather than about an item — the variety guard counts appearances, and
 * the in-session re-queue counts the items served since a miss. Neither is
 * derivable from the store.
 */
export class SessionPlanner {
  readonly returnMode: ReturnMode;
  /** Item ids the backlog compressor allowed through. */
  readonly servable: Set<string>;
  /** States the compressor pushed out. The store writes these once. */
  readonly postponed: ItemState[];
  /** Faucet allowance left in this session. */
  newItemsLeft: number;

  private readonly opts: PlannerOptions;
  private readonly rng: Rng;
  private readonly byId = new Map<string, DrillItem>();
  private readonly served = new Map<string, number>();
  /** Serve index before which a missed item is not eligible again. */
  private readonly cooldown = new Map<string, number>();
  private count = 0;

  constructor(opts: PlannerOptions) {
    this.opts = opts;
    this.rng = opts.rng ?? Math.random;
    this.returnMode = opts.returnMode;
    for (const item of opts.pool) this.byId.set(item.itemId, item);

    this.newItemsLeft = faucetAllowance(opts);

    const due = opts.pool
      .map((item) => ({ item, state: opts.states.get(item.itemId) }))
      .filter((d): d is { item: DrillItem; state: ItemState } => inSchedule(d.state))
      .filter((d) => d.state.status !== 'suspended' && d.state.dueAt <= opts.now);

    const eligible = opts.returnMode === 're-entry' ? strongestHalf(due) : due;
    const { serve, postponed } = compressBacklog(
      eligible,
      sessionCapacity(opts.budgetMin),
      opts.now,
      opts.progress
    );
    this.servable = serve;
    this.postponed = postponed;
  }

  /** How many items are due and allowed through, before anything is served. */
  get dueCount(): number {
    return this.servable.size;
  }

  get servedCount(): number {
    return this.count;
  }

  /**
   * The next item, or null when the session has nothing left to offer. Null is
   * a real answer and the screen says so: the faucet is a daily allowance and
   * the due pool is a date, so "nothing right now" is the system working.
   */
  next(): PlannedItem | null {
    const due = this.eligibleDue();
    const wantNew =
      this.newItemsLeft > 0 &&
      (due.length === 0 || this.count % Math.round(1 / NEW_ITEM_SHARE) === 1);

    if (wantNew) {
      const fresh = this.pickNew();
      if (fresh) return fresh;
    }
    if (due.length === 0) {
      // The 20% rhythm did not land on a new item this turn, but there is
      // nothing due either. Take a new one rather than end the session.
      return this.newItemsLeft > 0 ? this.pickNew() : null;
    }

    const chosen = softmaxPick(
      due,
      (c) => priority(c.state, this.opts.now, this.opts.progress),
      this.rng,
      this.opts.temperature
    );
    if (!chosen) return null;
    this.mark(chosen.item.itemId);
    return {
      item: chosen.item,
      state: chosen.state,
      reason: chosen.state.status === 'review' ? 'due' : 'learning',
    };
  }

  /** Record the outcome so the in-session rules can act on it. */
  record(itemId: string, rating: string): void {
    if (rating !== 'again') return;
    const [lo, hi] = REQUEUE_GAP;
    const gap = lo + Math.floor(this.rng() * (hi - lo + 1));
    this.cooldown.set(itemId, this.count + gap);
  }

  /** Serves used by this item so far, for the variety guard readout. */
  servesOf(itemId: string): number {
    return this.served.get(itemId) ?? 0;
  }

  private mark(itemId: string): void {
    this.served.set(itemId, this.servesOf(itemId) + 1);
    this.count += 1;
  }

  private eligibleDue(): { item: DrillItem; state: ItemState }[] {
    const out: { item: DrillItem; state: ItemState }[] = [];
    for (const itemId of this.servable) {
      const item = this.byId.get(itemId);
      const state = this.opts.states.get(itemId);
      if (!item || !state) continue;
      if (this.servesOf(itemId) >= MAX_SERVES_PER_SESSION) continue;
      if (this.count < (this.cooldown.get(itemId) ?? 0)) continue;
      // A miss re-queued this session is due immediately; a learning item on
      // its second step is due immediately too, and the variety guard above is
      // what turns that into "next session".
      out.push({ item, state });
    }
    return out;
  }

  /**
   * A new item, subject to the faucet and the load guard.
   *
   * The load guard ("never promote a new node if yesterday's session accuracy
   * was < 75%") is applied here rather than to the active set, because this is
   * where a node actually adds weight. Under the guard, items may still be
   * introduced from nodes already underway; only opening a node that has not
   * been started is withheld.
   */
  private pickNew(): PlannedItem | null {
    const guard =
      this.opts.yesterdayAccuracy !== null &&
      this.opts.yesterdayAccuracy < LOAD_GUARD_ACCURACY;

    const started = new Set<string>();
    if (guard) {
      for (const state of this.opts.states.values()) {
        // A node is not "underway" because the HUD overheard one of its chords.
        if (!inSchedule(state)) continue;
        for (const id of state.nodeIds) started.add(id);
      }
    }

    const fresh = this.opts.pool.filter((item) => {
      if (inSchedule(this.opts.states.get(item.itemId))) return false;
      if (this.servesOf(item.itemId) > 0) return false;
      if (guard && !item.nodeIds.some((id) => started.has(id))) return false;
      return true;
    });
    if (fresh.length === 0) return null;

    const item = fresh[Math.floor(this.rng() * fresh.length)]!;
    this.newItemsLeft -= 1;
    this.mark(item.itemId);
    return { item, state: null, reason: 'new' };
  }
}

/**
 * How many new items this session may introduce.
 *
 * Zero in re-entry mode and on the first day back from a four-to-seven day gap
 * (section 7), and zero while the difficulty governor has the faucet paused
 * (section 9: accuracy under 70%). Otherwise whatever is left of the day's
 * allowance.
 */
export function faucetAllowance(opts: {
  returnMode: ReturnMode;
  newItemsAllowed: number;
  rollingAccuracy: number | null;
}): number {
  if (opts.returnMode !== 'normal') return 0;
  if (opts.rollingAccuracy !== null && opts.rollingAccuracy < FAUCET_PAUSE_ACCURACY) {
    return 0;
  }
  return Math.max(0, opts.newItemsAllowed);
}

/**
 * section 7's re-entry rule: "only the user's *strongest* items (top-half
 * accEMA)". The return session is meant to be the easiest session there is.
 */
export function strongestHalf<T extends { state: ItemState }>(items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];
  const ranked = [...items].sort((a, b) => b.state.accEMA - a.state.accEMA);
  return ranked.slice(0, Math.ceil(ranked.length / 2));
}
