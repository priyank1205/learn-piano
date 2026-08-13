/**
 * Tests for in-session item order.
 *
 * The failure this guards against is not a crash, it is a practice session that
 * feels random: the same chord three times in a row, or an item that never
 * comes up. Both are what naive `Math.random()` selection does, and both read
 * as the app being broken rather than as sampling doing its job.
 */

import { describe, expect, it } from 'vitest';
import { ItemQueue, shuffle } from './queue.ts';
import type { DrillItem } from './types.ts';

/** Deterministic RNG, so "shuffled" is still an assertable claim. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deck = (n: number): DrillItem[] =>
  Array.from({ length: n }, (_, i) => ({
    itemId: `i${i}`,
    templateId: 't',
    params: { n: i },
    nodeIds: ['node'],
    label: `item ${i}`,
  }));

describe('shuffle', () => {
  it('keeps every element exactly once', () => {
    const items = deck(20);
    const out = shuffle(items, mulberry32(7));
    expect(out).toHaveLength(20);
    expect(new Set(out.map((i) => i.itemId)).size).toBe(20);
  });

  it('does not reorder the input', () => {
    const items = deck(10);
    shuffle(items, mulberry32(1));
    expect(items[0]!.itemId).toBe('i0');
  });
});

describe('ItemQueue', () => {
  it('serves every item once before serving any twice', () => {
    const q = new ItemQueue(deck(12), { rng: mulberry32(3) });
    const pass = Array.from({ length: 12 }, () => q.next()!.itemId);
    expect(new Set(pass).size).toBe(12);
  });

  it('reshuffles for the next pass rather than repeating the same order', () => {
    const q = new ItemQueue(deck(12), { rng: mulberry32(3) });
    const first = Array.from({ length: 12 }, () => q.next()!.itemId);
    const second = Array.from({ length: 12 }, () => q.next()!.itemId);
    expect(new Set(second).size).toBe(12);
    expect(second).not.toEqual(first);
  });

  /**
   * The deck boundary is invisible to the user, so the last item of one pass
   * and the first of the next must not be the same chord.
   */
  it('never serves the same item twice in a row across a reshuffle', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const q = new ItemQueue(deck(6), { rng: mulberry32(seed) });
      let previous: string | null = null;
      for (let i = 0; i < 60; i += 1) {
        const item = q.next()!;
        expect(item.itemId).not.toBe(previous);
        previous = item.itemId;
      }
    }
  });

  it('serves a single-item deck without looping forever', () => {
    const q = new ItemQueue(deck(1), { rng: mulberry32(5) });
    expect(q.next()!.itemId).toBe('i0');
    expect(q.next()!.itemId).toBe('i0');
  });

  it('returns null for an empty deck', () => {
    expect(new ItemQueue([], { rng: mulberry32(5) }).next()).toBeNull();
  });

  /** session-generator.md section 2: `again` comes back after 3 to 6 items. */
  it('brings a missed item back within the requeue window', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const q = new ItemQueue(deck(20), { rng: mulberry32(seed) });
      const missed = q.next()!;
      q.requeue(missed);

      const following: string[] = [];
      for (let i = 0; i < 8; i += 1) following.push(q.next()!.itemId);

      const at = following.indexOf(missed.itemId);
      expect(at).toBeGreaterThanOrEqual(3);
      expect(at).toBeLessThanOrEqual(6);
    }
  });

  it('honours a custom requeue window', () => {
    const q = new ItemQueue(deck(20), { rng: mulberry32(11), requeueGap: [1, 1] });
    const missed = q.next()!;
    q.requeue(missed);
    q.next();
    expect(q.next()!.itemId).toBe(missed.itemId);
  });

  it('reports how much of the pass is left', () => {
    const q = new ItemQueue(deck(5), { rng: mulberry32(2) });
    expect(q.remaining).toBe(5);
    q.next();
    expect(q.remaining).toBe(4);
  });
});
