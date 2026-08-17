/**
 * The SM-2 variant (session-generator.md section 2), as pure arithmetic.
 *
 * The design stance in one line: **correctness gates, latency grades.** The
 * user's deficit is speed, not knowledge, so a right answer is not a uniform
 * success — a right answer in 4 seconds is `hard` and the same answer in 900ms
 * is `easy`, and they schedule differently. Everything else here follows from
 * that.
 *
 * Nothing in this file touches storage, the clock, or React. Every input is an
 * argument, including `now` and the random source, so the whole scheduler is
 * testable without a database and a rep from 1 March 2027 grades the same way
 * on any machine.
 *
 * Three places the written spec had to be reconciled rather than transcribed.
 * All three are called out at the rule they affect.
 */

import type { ItemState, ItemStatus, Rating } from '../store/types.ts';
import { HISTORY_LENGTH } from '../store/types.ts';
import type { Track } from '../tree.ts';
import { nodeById } from '../tree.ts';
import type { LatencyBands } from '../grade/index.ts';
import { LATENCY_BANDS } from '../grade/index.ts';
import { DAY_MS } from '../store/weeks.ts';

/** Injectable so tests are deterministic. Returns [0, 1). */
export type Rng = () => number;

export const EASE_START = 2.3;
export const EASE_MIN = 1.3;
export const EASE_MAX = 2.9;

/** session-generator.md section 2. */
export const EASE_DELTA: Record<Rating, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.1,
};

export const EMA_ALPHA = 0.3;

/** Interval fuzz, so decks do not clump onto the same day. */
export const INTERVAL_FUZZ = 0.15;

/**
 * "motor skills decay faster than declarative recall — the caps are guesses"
 * (session-generator.md section 2, and architecture.md section 9 lists them as
 * the first thing to re-tune).
 */
export const TRACK_INTERVAL_CAP_DAYS: Record<Track, number> = {
  'physical-rhythm': 14,
  ear: 30,
  'keyboard-theory': 45,
};

/** Learning steps: in-session re-queue, then next session, then graduate. */
export const LEARNING_STEPS = 2;

/**
 * The cap for an item, which is the **strictest** of its nodes' tracks.
 *
 * An item belongs to several nodes (slice 4) and could in principle span
 * tracks. Taking the minimum is the conservative reading of the rule the caps
 * encode: if any part of a skill is motor, it decays at the motor rate, and
 * scheduling it at the declarative rate would let the physical half rot between
 * reps. Unknown nodes fall back to the shortest cap rather than the longest,
 * for the same reason.
 */
const SHORTEST_CAP_DAYS = Math.min(...Object.values(TRACK_INTERVAL_CAP_DAYS));

export function intervalCapDays(nodeIds: readonly string[]): number {
  let cap = SHORTEST_CAP_DAYS;
  let seen = false;
  for (const id of nodeIds) {
    const track = nodeById(id)?.track;
    if (!track) continue;
    cap = seen
      ? Math.min(cap, TRACK_INTERVAL_CAP_DAYS[track])
      : TRACK_INTERVAL_CAP_DAYS[track];
    seen = true;
  }
  return cap;
}

export const clampEase = (ease: number): number =>
  Math.min(EASE_MAX, Math.max(EASE_MIN, ease));

/**
 * The rating for one graded rep (session-generator.md section 2).
 *
 * `latencyMs` is null in two unrelated cases and they are not the same fact.
 * A timed drill has no latency by construction, and section 2's pass rules say
 * a clean pass at target is `good`. An untimed drill with a null latency was
 * never answered at all, and correctness has already made it `again`.
 */
export function ratingFor(
  correct: boolean,
  latencyMs: number | null,
  bands: LatencyBands = LATENCY_BANDS
): Rating {
  if (!correct) return 'again';
  if (latencyMs === null) return 'good';
  if (latencyMs < bands.automaticMs) return 'easy';
  if (latencyMs <= bands.knownMs) return 'good';
  return 'hard';
}

export const RATING_LABELS: Record<Rating, string> = {
  again: 'again',
  hard: 'hard',
  good: 'good',
  easy: 'easy',
};

/**
 * An exponential moving average that **seeds on its first observation**.
 *
 * Starting from zero would make one correct rep read as 30% accurate and one
 * 900ms answer read as a 270ms one, and `itemMastered` compares `accEMA`
 * against a 0.9-ish threshold, so a zero seed silently adds several reps to
 * every item's path to mastery. The spec gives alpha and says nothing about the
 * seed; this is the only reading under which the number means what it is named.
 */
export function ema(previous: number | null, value: number, alpha = EMA_ALPHA): number {
  return previous === null ? value : previous + alpha * (value - previous);
}

export function newItemState(
  itemId: string,
  nodeIds: readonly string[],
  now: number
): ItemState {
  return {
    itemId,
    nodeIds: [...nodeIds],
    status: 'new',
    ease: EASE_START,
    intervalDays: 0,
    dueAt: now,
    reps: 0,
    lapses: 0,
    accEMA: 0,
    latEMA: 0,
    step: 0,
    history: [],
    introducedAt: null,
    updatedAt: now,
  };
}

export interface ApplyOptions {
  now: number;
  rng?: Rng;
  /** Suspend as a leech at this many lapses (section 9). Default 8. */
  leechLapses?: number;
  /** Set false to compare intervals in tests without the +-15%. */
  fuzz?: boolean;
}

/** +-15% so decks do not all come due on the same morning. */
export function fuzzInterval(days: number, rng: Rng): number {
  return days * (1 + (rng() * 2 - 1) * INTERVAL_FUZZ);
}

/**
 * The scheduling update. Returns a new state; the argument is never mutated,
 * because the store keeps the previous value until the write resolves.
 *
 * **Reconciliation 1: what a lapsed item graduates to.** Section 2 says a
 * lapse sets `interval = max(1, interval * 0.3)` and, two lines later, that
 * learning items "graduate at interval 1d (2d if easy)". Read literally the
 * first line is dead: the reduced interval is overwritten by 1d the moment the
 * item graduates, and a card that had reached 40 days restarts as if it were
 * new. Graduating at `max(1, intervalDays)` — `max(2, ...)` when easy — honours
 * both: a genuinely new item has interval 0 and graduates at exactly 1d or 2d
 * as written, while a lapsed item keeps the 30% it was reduced to.
 *
 * **Reconciliation 2: `latEMA` on a wrong answer.** Section 2 says both EMAs
 * update "on every rep". But `latEMA` feeds `itemMastered` (section 1.2) as a
 * measure of how fast the item is *known*, and the time taken to play a wrong
 * chord measures nothing: a confident wrong answer is fast and would improve
 * the number. `accEMA` updates on every rep, `latEMA` only on correct ones.
 * This matches the decision `summarise()` already makes for `automaticShare`,
 * which the tree uses to call a deck complete.
 *
 * **Reconciliation 3: what "next session" means as a timestamp.** The learning
 * steps are "[in-session re-queue, next session]", and there is no way to know
 * when the next session is. Both steps are therefore due immediately, and the
 * per-session variety guard (section 4: an item appears at most twice per
 * session) is what pushes the second step out of today. That is not a
 * workaround: section 4 names the learning-step re-queue as the second of the
 * two appearances, so the two rules were already describing one mechanism.
 */
export function applyRating(
  state: ItemState,
  rating: Rating,
  correct: boolean,
  latencyMs: number | null,
  opts: ApplyOptions
): ItemState {
  const { now } = opts;
  const rng = opts.rng ?? Math.random;
  const leechLapses = opts.leechLapses ?? 8;
  const useFuzz = opts.fuzz ?? true;

  const ease = clampEase(state.ease + EASE_DELTA[rating]);
  const wasReview = state.status === 'review';

  let status: ItemStatus = state.status;
  let step = state.step;
  let intervalDays = state.intervalDays;
  let lapses = state.lapses;
  /** Learning steps are due immediately; only a scheduled review moves this. */
  let dueAt: number;

  const cap = intervalCapDays(state.nodeIds);
  const schedule = (days: number): number => {
    const withFuzz = useFuzz ? fuzzInterval(days, rng) : days;
    // Capped after the fuzz, not before, so the cap is a cap. Never below one
    // day either: a review is a different session, by definition.
    intervalDays = Math.min(cap, Math.max(1, withFuzz));
    return now + intervalDays * DAY_MS;
  };

  const graduate = (): number => {
    status = 'review';
    step = LEARNING_STEPS;
    const floor = rating === 'easy' ? 2 : 1;
    return schedule(Math.max(floor, intervalDays));
  };

  if (rating === 'again') {
    // A lapse is only a lapse if there was something to lose. Failing an item
    // that was still being learned is the learning step doing its job, and
    // counting it would suspend new material as a leech within one session.
    if (wasReview) {
      lapses += 1;
      intervalDays = Math.max(1, intervalDays * 0.3);
    }
    status = 'learning';
    step = 0;
    dueAt = now;
  } else if (status === 'review') {
    const factor = rating === 'hard' ? 1.2 : rating === 'good' ? ease : ease * 1.3;
    dueAt = schedule(intervalDays * factor);
  } else {
    // New or learning. `hard` repeats the current step rather than advancing.
    if (rating === 'easy') {
      dueAt = graduate();
    } else {
      const next = rating === 'good' ? step + 1 : step;
      if (next >= LEARNING_STEPS) {
        dueAt = graduate();
      } else {
        status = 'learning';
        step = next;
        dueAt = now;
      }
    }
  }

  if (lapses >= leechLapses) {
    // section 9: suspended from the auto-queue, surfaced once in the UI. The
    // remedial variant that section also asks for needs a drill template that
    // can generate one, which no template can yet.
    status = 'suspended';
  }

  const entry = { ts: now, rating, correct, latencyMs };
  const history = [...state.history, entry].slice(-HISTORY_LENGTH);

  return {
    ...state,
    status,
    ease,
    intervalDays,
    dueAt,
    step,
    reps: state.reps + 1,
    lapses,
    accEMA: ema(state.reps === 0 ? null : state.accEMA, correct ? 1 : 0),
    latEMA:
      correct && latencyMs !== null
        ? ema(hasLatency(state) ? state.latEMA : null, latencyMs)
        : state.latEMA,
    history,
    introducedAt: state.introducedAt ?? now,
    updatedAt: now,
  };
}

/**
 * Whether `latEMA` holds an observation yet rather than its zero seed. Zero is
 * not a reachable latency: it is measured from the prompt being painted to the
 * last note of the answer going down, and both are real events.
 */
export function hasLatency(state: ItemState): boolean {
  return state.latEMA > 0;
}

/**
 * Bring a suspended leech back. Nothing does this automatically: section 9 is
 * explicit that a leech needs "a different approach", and re-serving the same
 * failing form on a timer is precisely the thing it forbids. The lapse count
 * drops to one below the threshold so a single further failure suspends it
 * again rather than granting eight more.
 */
export function revive(state: ItemState, now: number, leechLapses = 8): ItemState {
  if (state.status !== 'suspended') return state;
  return {
    ...state,
    status: 'learning',
    step: 0,
    lapses: Math.max(0, leechLapses - 1),
    dueAt: now,
    updatedAt: now,
  };
}
