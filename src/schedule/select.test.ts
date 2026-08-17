/**
 * Tests for item selection (session-generator.md sections 3, 4 and 7).
 *
 * Section 9 lists four failure modes this file is responsible for preventing,
 * and each one has a test here: "same items forever" (softmax sampling and the
 * variety guard), the wall of due items after a gap (backlog compression), the
 * return session that punishes you for coming back (re-entry), and adding new
 * material during a bad week (the faucet and the load guard).
 */

import { describe, expect, it } from 'vitest';
import {
  BACKLOG_FACTOR,
  LEECH_SHADOW,
  MAX_SERVES_PER_SESSION,
  SessionPlanner,
  compressBacklog,
  faucetAllowance,
  leechShadow,
  priority,
  sessionCapacity,
  softmaxPick,
  strongestHalf,
} from './select.ts';
import { newItemState } from './srs.ts';
import { deriveProgress } from './mastery.ts';
import type { ItemState } from '../store/types.ts';
import { DAY_MS } from '../store/weeks.ts';
import type { DrillItem } from '../drills/types.ts';

const NOW = new Date(2026, 7, 12, 10, 0, 0).getTime();
const NODE = 'kt-inv-maj-triads';

const item = (id: string): DrillItem => ({
  itemId: id,
  templateId: 'inversion-trainer',
  params: { id },
  nodeIds: [NODE],
  label: id,
});

function state(id: string, over: Partial<ItemState> = {}): ItemState {
  return {
    ...newItemState(id, [NODE], NOW),
    status: 'review',
    step: 2,
    intervalDays: 5,
    dueAt: NOW,
    reps: 5,
    accEMA: 0.9,
    latEMA: 1100,
    ...over,
  };
}

/** A progress map with the node in play, so `nodeWeight` is the learning 1.5. */
const progressWith = (states: ItemState[]) =>
  deriveProgress(new Map(states.map((s) => [s.itemId, s]))).progress;

/** Cycles through fixed rolls, so a "random" choice is an assertion. */
function seeded(rolls: readonly number[]): () => number {
  let i = 0;
  return () => rolls[i++ % rolls.length]!;
}

describe('priority', () => {
  const progress = progressWith([]);

  it('rises with the square root of how overdue an item is', () => {
    const onTime = priority(state('a'), NOW, progress);
    const threeDays = priority(state('b', { dueAt: NOW - 3 * DAY_MS }), NOW, progress);
    expect(threeDays / onTime).toBeCloseTo(Math.sqrt(4));
  });

  it('does not reward an item for being early', () => {
    const early = state('a', { dueAt: NOW + 5 * DAY_MS });
    expect(priority(early, NOW, progress)).toBeCloseTo(
      priority(state('b'), NOW, progress)
    );
  });

  it('halves a leech without silencing it', () => {
    expect(leechShadow(state('a', { lapses: 4 }))).toBe(1);
    expect(leechShadow(state('a', { lapses: 5 }))).toBe(LEECH_SHADOW);
    const shadowed = priority(state('a', { lapses: 5 }), NOW, progress);
    expect(shadowed).toBeGreaterThan(0);
    expect(shadowed).toBeCloseTo(priority(state('b'), NOW, progress) * LEECH_SHADOW);
  });
});

describe('softmax sampling', () => {
  it('is sampling, not sorting', () => {
    const items = ['low', 'high'];
    const weight = (c: string) => (c === 'high' ? 3 : 1);
    // A roll near the top of the distribution reaches the lower-priority item,
    // which strict priority order never would. That is the whole defence
    // against "same items forever".
    const picks = new Set(
      [0.01, 0.5, 0.99].map((r) => softmaxPick(items, weight, () => r, 0.7))
    );
    expect(picks.size).toBe(2);
  });

  it('still favours priority', () => {
    const items = ['low', 'high'];
    const weight = (c: string) => (c === 'high' ? 3 : 1);
    const rolls = Array.from({ length: 200 }, (_, i) => i / 200);
    const high = rolls.filter(
      (r) => softmaxPick(items, weight, () => r, 0.7) === 'high'
    ).length;
    // exp(3/0.7) / (exp(3/0.7) + exp(1/0.7)) is about 0.94.
    expect(high / rolls.length).toBeGreaterThan(0.85);
  });

  it('does not produce NaN at a temperature approaching zero', () => {
    // exp(3 / 0.001) is Infinity, which would turn the distribution into NaN
    // and pick nothing at all.
    const picked = softmaxPick(
      ['a', 'b'],
      (c) => (c === 'a' ? 3 : 1),
      () => 0.5,
      1e-9
    );
    expect(picked).not.toBeNull();
  });

  it('returns null only for an empty pool', () => {
    expect(softmaxPick([], () => 1, Math.random, 0.7)).toBeNull();
    expect(softmaxPick(['only'], () => 1, Math.random, 0.7)).toBe('only');
  });
});

describe('backlog compression', () => {
  const progress = progressWith([]);
  const due = Array.from({ length: 60 }, (_, i) => ({
    item: item(`i${i}`),
    state: state(`i${i}`, { dueAt: NOW - 4 * DAY_MS }),
  }));

  it('serves at most 1.5 times one session capacity', () => {
    const capacity = sessionCapacity(2);
    const { serve, postponed } = compressBacklog(due, capacity, NOW, progress);
    expect(serve.size).toBe(Math.ceil(capacity * BACKLOG_FACTOR));
    expect(postponed).toHaveLength(due.length - serve.size);
  });

  it('postpones the rest silently, with no penalty', () => {
    const { postponed } = compressBacklog(due, sessionCapacity(2), NOW, progress);
    for (const s of postponed) {
      // No lapse, no ease change, nothing to see. Just a later date.
      expect(s.lapses).toBe(0);
      expect(s.ease).toBe(state('x').ease);
      expect(s.dueAt).toBeGreaterThan(NOW);
    }
  });

  it('does nothing at all when the backlog fits', () => {
    const small = due.slice(0, 3);
    const { serve, postponed } = compressBacklog(
      small,
      sessionCapacity(15),
      NOW,
      progress
    );
    expect(serve.size).toBe(3);
    expect(postponed).toEqual([]);
  });
});

describe('the new-item faucet', () => {
  it('is closed in re-entry and on the first day back from a gap', () => {
    expect(
      faucetAllowance({
        returnMode: 're-entry',
        newItemsAllowed: 8,
        rollingAccuracy: 0.9,
      })
    ).toBe(0);
    expect(
      faucetAllowance({ returnMode: 'gentle', newItemsAllowed: 8, rollingAccuracy: 0.9 })
    ).toBe(0);
  });

  it('is closed while the governor says accuracy is under 70%', () => {
    expect(
      faucetAllowance({ returnMode: 'normal', newItemsAllowed: 8, rollingAccuracy: 0.69 })
    ).toBe(0);
    expect(
      faucetAllowance({ returnMode: 'normal', newItemsAllowed: 8, rollingAccuracy: 0.71 })
    ).toBe(8);
  });

  it('is open on a first run, when there is no accuracy yet', () => {
    expect(
      faucetAllowance({ returnMode: 'normal', newItemsAllowed: 8, rollingAccuracy: null })
    ).toBe(8);
  });
});

describe('re-entry', () => {
  it('serves only the strongest half', () => {
    const items = [0.4, 0.6, 0.8, 1].map((acc, i) => ({
      state: state(`i${i}`, { accEMA: acc }),
    }));
    const kept = strongestHalf(items).map((k) => k.state.accEMA);
    expect(kept).toEqual([1, 0.8]);
  });
});

describe('the session planner', () => {
  const pool = Array.from({ length: 10 }, (_, i) => item(`i${i}`));
  const states = new Map(pool.map((p) => [p.itemId, state(p.itemId)]));

  const planner = (over: Partial<ConstructorParameters<typeof SessionPlanner>[0]> = {}) =>
    new SessionPlanner({
      now: NOW,
      pool,
      states,
      progress: progressWith([...states.values()]),
      returnMode: 'normal',
      budgetMin: 15,
      temperature: 0.7,
      newItemsAllowed: 0,
      rollingAccuracy: 0.9,
      yesterdayAccuracy: 0.9,
      rng: seeded([0.5]),
      ...over,
    });

  it('serves an item at most twice per session', () => {
    const p = planner();
    const counts = new Map<string, number>();
    for (let i = 0; i < 50; i += 1) {
      const next = p.next();
      if (!next) break;
      counts.set(next.item.itemId, (counts.get(next.item.itemId) ?? 0) + 1);
    }
    for (const n of counts.values())
      expect(n).toBeLessThanOrEqual(MAX_SERVES_PER_SESSION);
    // Twenty serves over ten items, and then genuinely nothing left.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(
      pool.length * MAX_SERVES_PER_SESSION
    );
  });

  it('holds a missed item back for three to six others', () => {
    const p = planner();
    const first = p.next()!;
    p.record(first.item.itemId, 'again');

    const following: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = p.next();
      if (next) following.push(next.item.itemId);
    }
    // Three others at minimum before it can return.
    expect(following.slice(0, 3)).not.toContain(first.item.itemId);
  });

  it('returns null rather than inventing something to serve', () => {
    const p = planner({ states: new Map(), newItemsAllowed: 0 });
    expect(p.next()).toBeNull();
  });

  it('introduces new items when the faucet is open and nothing is due', () => {
    const p = planner({ states: new Map(), newItemsAllowed: 3 });
    const reasons = [p.next(), p.next(), p.next(), p.next()].map(
      (n) => n?.reason ?? null
    );
    expect(reasons).toEqual(['new', 'new', 'new', null]);
  });

  it('mixes new items in at about one in five when there is a backlog', () => {
    // Half the pool is due and half has never been seen, so the planner has a
    // real choice to make on every turn.
    const half = new Map([...states].slice(0, 5));
    const p = planner({
      states: half,
      progress: progressWith([...half.values()]),
      newItemsAllowed: 8,
    });
    const reasons: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const next = p.next();
      if (next) reasons.push(next.reason);
    }
    const fresh = reasons.filter((r) => r === 'new').length;
    // Section 6: "up to 20% of block items may be NEW".
    expect(fresh).toBe(2);
  });

  it('withholds an unstarted node after a bad day, but not a started one', () => {
    // Yesterday went badly, so the load guard applies. Every pool item belongs
    // to a node that already has state, so new items may still be introduced.
    const partial = new Map([[pool[0]!.itemId, state(pool[0]!.itemId)]]);
    const started = planner({
      states: partial,
      newItemsAllowed: 5,
      yesterdayAccuracy: 0.5,
    });
    expect(started.next()).not.toBeNull();

    // Nothing has been started at all, so opening a node is what is withheld.
    const cold = planner({
      states: new Map(),
      newItemsAllowed: 5,
      yesterdayAccuracy: 0.5,
    });
    expect(cold.next()).toBeNull();
  });

  it('compresses the backlog it was handed and reports what it postponed', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`b${i}`));
    const overdue = new Map(
      many.map((m) => [m.itemId, state(m.itemId, { dueAt: NOW - 3 * DAY_MS })])
    );
    const p = planner({ pool: many, states: overdue, budgetMin: 5 });
    expect(p.dueCount).toBe(Math.ceil(sessionCapacity(5) * BACKLOG_FACTOR));
    expect(p.postponed.length).toBe(many.length - p.dueCount);
  });
});
