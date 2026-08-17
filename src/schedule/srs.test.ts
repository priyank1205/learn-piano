/**
 * Tests for the SM-2 variant (session-generator.md section 2).
 *
 * Half of these pin arithmetic and half pin the three places the spec had to be
 * reconciled rather than transcribed. The reconciliations are the ones worth
 * having tests for: they are decisions, they are invisible from the outside,
 * and the next person to read section 2 will read it the same literal way that
 * produced the problem in the first place.
 */

import { describe, expect, it } from 'vitest';
import {
  EASE_MAX,
  EASE_MIN,
  EASE_START,
  INTERVAL_FUZZ,
  TRACK_INTERVAL_CAP_DAYS,
  applyRating,
  ema,
  intervalCapDays,
  newItemState,
  ratingFor,
  revive,
} from './srs.ts';
import type { ItemState } from '../store/types.ts';
import { DAY_MS } from '../store/weeks.ts';

const NOW = new Date(2026, 7, 12, 10, 0, 0).getTime();
/** keyboard-theory, so the interval cap is 45 days. */
const NODE = 'kt-inv-maj-triads';
/** physical-rhythm, cap 14. */
const PHYSICAL = 'pr-legato-5finger';

const fresh = (): ItemState => newItemState('item', [NODE], NOW);

/** No fuzz, so an interval can be compared to a number. */
const apply = (
  state: ItemState,
  rating: Parameters<typeof applyRating>[1],
  correct = rating !== 'again',
  latencyMs: number | null = correct ? 900 : null
) => applyRating(state, rating, correct, latencyMs, { now: NOW, fuzz: false });

const review = (over: Partial<ItemState> = {}): ItemState => ({
  ...fresh(),
  status: 'review',
  step: 2,
  intervalDays: 10,
  reps: 6,
  accEMA: 0.95,
  latEMA: 1000,
  dueAt: NOW,
  history: [{ ts: NOW - DAY_MS, rating: 'good', correct: true, latencyMs: 1000 }],
  ...over,
});

describe('ratingFor', () => {
  it('lets correctness gate and latency grade', () => {
    expect(ratingFor(false, 800)).toBe('again');
    expect(ratingFor(true, 800)).toBe('easy');
    expect(ratingFor(true, 2000)).toBe('good');
    expect(ratingFor(true, 4000)).toBe('hard');
  });

  it('reads the band edges the way the table does', () => {
    // "< 1200ms automatic", "1200-3000 known", "> 3000 not known".
    expect(ratingFor(true, 1199)).toBe('easy');
    expect(ratingFor(true, 1200)).toBe('good');
    expect(ratingFor(true, 3000)).toBe('good');
    expect(ratingFor(true, 3001)).toBe('hard');
  });

  it('treats a correct rep with no latency as a clean pass', () => {
    // A timed drill has no latency by construction, and section 2's pass rules
    // make a clean pass at target `good`.
    expect(ratingFor(true, null)).toBe('good');
  });
});

describe('ease', () => {
  it('moves by the deltas in section 2', () => {
    expect(apply(review(), 'again').ease).toBeCloseTo(EASE_START - 0.2);
    expect(apply(review(), 'hard').ease).toBeCloseTo(EASE_START - 0.15);
    expect(apply(review(), 'good').ease).toBeCloseTo(EASE_START);
    expect(apply(review(), 'easy').ease).toBeCloseTo(EASE_START + 0.1);
  });

  it('clamps to [1.3, 2.9]', () => {
    let state = review({ ease: EASE_MIN });
    state = apply(state, 'again');
    expect(state.ease).toBe(EASE_MIN);

    let high = review({ ease: EASE_MAX });
    high = apply(high, 'easy');
    expect(high.ease).toBe(EASE_MAX);
  });
});

describe('the learning steps', () => {
  it('takes two goods to graduate a new item, at one day', () => {
    const first = apply(fresh(), 'good');
    expect(first.status).toBe('learning');
    expect(first.step).toBe(1);
    // Due immediately: the per-session variety guard is what makes step 1
    // "next session". See reconciliation 3.
    expect(first.dueAt).toBe(NOW);

    const second = apply(first, 'good');
    expect(second.status).toBe('review');
    expect(second.intervalDays).toBe(1);
    expect(second.dueAt).toBe(NOW + DAY_MS);
  });

  it('graduates a new item straight out on easy, at two days', () => {
    const state = apply(fresh(), 'easy');
    expect(state.status).toBe('review');
    expect(state.intervalDays).toBe(2);
  });

  it('repeats the step on hard rather than advancing it', () => {
    const state = apply(fresh(), 'hard', true, 4000);
    expect(state.status).toBe('learning');
    expect(state.step).toBe(0);
  });

  it('sends a missed item back to the first step', () => {
    const mid = apply(fresh(), 'good');
    const missed = apply(mid, 'again');
    expect(missed.status).toBe('learning');
    expect(missed.step).toBe(0);
    expect(missed.dueAt).toBe(NOW);
  });

  it('does not count a failed learning item as a lapse', () => {
    // Failing something still being learned is the learning step working. If
    // it counted, new material would suspend itself as a leech inside one
    // session, since a miss re-queues immediately.
    let state = fresh();
    for (let i = 0; i < 9; i += 1) state = apply(state, 'again');
    expect(state.lapses).toBe(0);
    expect(state.status).toBe('learning');
  });
});

describe('review intervals', () => {
  it('multiplies by the factors in section 2', () => {
    expect(apply(review({ intervalDays: 10 }), 'hard').intervalDays).toBeCloseTo(12);
    expect(
      apply(review({ intervalDays: 10, ease: 2.3 }), 'good').intervalDays
    ).toBeCloseTo(23);
    // easy raises ease first, then multiplies by ease * 1.3.
    expect(
      apply(review({ intervalDays: 10, ease: 2.3 }), 'easy').intervalDays
    ).toBeCloseTo(10 * 2.4 * 1.3);
  });

  it('caps by the strictest track an item belongs to', () => {
    expect(intervalCapDays([NODE])).toBe(TRACK_INTERVAL_CAP_DAYS['keyboard-theory']);
    expect(intervalCapDays([PHYSICAL])).toBe(TRACK_INTERVAL_CAP_DAYS['physical-rhythm']);
    // Motor decay wins: an item that is partly physical is scheduled at the
    // physical rate rather than the declarative one.
    expect(intervalCapDays([NODE, PHYSICAL])).toBe(
      TRACK_INTERVAL_CAP_DAYS['physical-rhythm']
    );

    const long = apply(review({ intervalDays: 40 }), 'easy');
    expect(long.intervalDays).toBe(TRACK_INTERVAL_CAP_DAYS['keyboard-theory']);
  });

  it('fuzzes within +-15% and never above the cap', () => {
    const cap = TRACK_INTERVAL_CAP_DAYS['keyboard-theory'];
    for (const roll of [0, 0.5, 0.999999]) {
      const state = applyRating(review({ intervalDays: 10 }), 'good', true, 900, {
        now: NOW,
        rng: () => roll,
      });
      expect(state.intervalDays).toBeGreaterThanOrEqual(23 * (1 - INTERVAL_FUZZ) - 1e-6);
      expect(state.intervalDays).toBeLessThanOrEqual(23 * (1 + INTERVAL_FUZZ) + 1e-6);
      expect(state.intervalDays).toBeLessThanOrEqual(cap);
    }
  });
});

describe('lapses', () => {
  it('reduces the interval to 30% and puts the item back in learning', () => {
    const lapsed = apply(review({ intervalDays: 20 }), 'again');
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.status).toBe('learning');
    expect(lapsed.step).toBe(0);
    expect(lapsed.intervalDays).toBeCloseTo(6);
  });

  /**
   * Reconciliation 1. Read literally, "graduate at interval 1d" throws away the
   * `max(1, interval * 0.3)` two lines above it, and a card that had reached 40
   * days restarts as if it had never been learned.
   */
  it('graduates a lapsed item back to its reduced interval, not to one day', () => {
    const lapsed = apply(review({ intervalDays: 20 }), 'again');
    const back = apply(apply(lapsed, 'good'), 'good');
    expect(back.status).toBe('review');
    expect(back.intervalDays).toBeCloseTo(6);
  });

  it('still graduates a genuinely new item at exactly one day', () => {
    const graduated = apply(apply(fresh(), 'good'), 'good');
    expect(graduated.intervalDays).toBe(1);
  });

  it('suspends a leech and does not un-suspend it by itself', () => {
    let state = review({ lapses: 7 });
    state = apply(state, 'again');
    expect(state.lapses).toBe(8);
    expect(state.status).toBe('suspended');

    // A correct answer does not quietly return it to the queue: section 9 is
    // explicit that a leech needs a different approach, not another turn.
    expect(apply(state, 'easy').status).toBe('suspended');

    const revived = revive(state, NOW);
    expect(revived.status).toBe('learning');

    // A revived leech goes back through the learning steps, and a miss in
    // there is not a lapse: relearning an item is exactly the situation where
    // getting it wrong is expected. What is on a last chance is the next
    // failure out of *review*, which suspends it again rather than granting
    // another eight.
    expect(apply(revived, 'again').lapses).toBe(7);
    const relearned = apply(apply(revived, 'good'), 'good');
    expect(relearned.status).toBe('review');
    expect(apply(relearned, 'again').status).toBe('suspended');
  });
});

describe('the moving averages', () => {
  it('seeds on the first observation instead of starting at zero', () => {
    expect(ema(null, 900)).toBe(900);
    expect(ema(1000, 900)).toBeCloseTo(970);

    const first = apply(fresh(), 'easy', true, 900);
    expect(first.accEMA).toBe(1);
    expect(first.latEMA).toBe(900);
  });

  /**
   * Reconciliation 2. Section 2 says both EMAs update on every rep, but latEMA
   * feeds `itemMastered` as a measure of how fast the item is *known*, and a
   * confident wrong answer is fast.
   */
  it('updates accEMA on every rep and latEMA only on correct ones', () => {
    const correct = apply(fresh(), 'easy', true, 900);
    const wrong = applyRating(correct, 'again', false, 200, { now: NOW, fuzz: false });

    expect(wrong.accEMA).toBeCloseTo(0.7);
    // A 200ms wrong chord must not report as having got faster.
    expect(wrong.latEMA).toBe(900);
  });

  it('keeps the last ten reps and no more', () => {
    let state = fresh();
    for (let i = 0; i < 15; i += 1) state = apply(state, 'good');
    expect(state.history).toHaveLength(10);
    expect(state.reps).toBe(15);
  });
});
