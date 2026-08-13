/**
 * Tests for the session statistics.
 *
 * `automaticShare` is the one that matters. It is the statistic the tree uses
 * to decide a deck is finished, and it is easy to compute three plausible ways:
 * over all reps, over correct reps, or counting a miss as slow. Only one of
 * them matches `masteryThreshold.automaticShare`, and getting it wrong would
 * quietly move the finishing line for the whole curriculum.
 *
 * The practice loop itself is not tested here. It is animation frames, a MIDI
 * subscription and a shared runner, which is integration rather than
 * arithmetic; the arithmetic is all in `summarise`.
 */

import { describe, expect, it } from 'vitest';
import { summarise } from './practice.ts';
import type { PracticeRep } from './practice.ts';
import type { DrillItem } from './types.ts';
import type { GradeResult, Rep } from '../grade/index.ts';

const item = (id: string): DrillItem => ({
  itemId: id,
  templateId: 't',
  params: { id },
  nodeIds: ['node'],
  label: id,
});

function rep(id: string, correct: boolean, latencyMs: number | null): PracticeRep {
  const result: GradeResult = {
    correct,
    score: correct ? 1 : 0,
    latencyMs,
    timingErrorMs: null,
    noteOverlapMs: null,
    noteErrors: { missing: [], extra: [], wrong: [] },
    spreadMsMax: null,
    handOnsetSkewMs: null,
    perEvent: [],
    raw: [],
  };
  return { item: item(id), rep: { spec: {} as Rep['spec'], result } };
}

describe('summarise', () => {
  it('is empty and not NaN with no reps', () => {
    const s = summarise([]);
    expect(s.reps).toBe(0);
    expect(s.accuracy).toBe(0);
    expect(s.automaticShare).toBe(0);
    expect(s.medianLatencyMs).toBeNull();
    expect(s.byItem).toEqual([]);
  });

  it('counts accuracy over every rep', () => {
    const s = summarise([
      rep('a', true, 800),
      rep('b', false, 900),
      rep('c', true, 1000),
      rep('d', true, 1100),
    ]);
    expect(s.reps).toBe(4);
    expect(s.correct).toBe(3);
    expect(s.accuracy).toBeCloseTo(0.75, 9);
  });

  /**
   * A miss has no meaningful latency: the note that completed the chord was the
   * wrong note. Counting it either way would misreport the share the tree reads.
   */
  it('measures the automatic share over correct reps only', () => {
    const s = summarise([
      rep('a', true, 900), // automatic
      rep('b', true, 1100), // automatic
      rep('c', true, 2000), // known
      rep('d', false, 400), // fast and wrong: not evidence of anything
    ]);
    expect(s.automaticShare).toBeCloseTo(2 / 3, 9);
  });

  it('takes the median latency over correct reps', () => {
    const s = summarise([
      rep('a', true, 500),
      rep('b', true, 1500),
      rep('c', true, 4000),
      rep('d', false, null),
    ]);
    expect(s.medianLatencyMs).toBe(1500);
  });

  it('groups reps by item', () => {
    const s = summarise([
      rep('a', true, 1000),
      rep('a', true, 2000),
      rep('b', true, 800),
    ]);
    const a = s.byItem.find((row) => row.item.itemId === 'a')!;
    expect(a.reps).toBe(2);
    expect(a.correct).toBe(2);
    expect(a.medianLatencyMs).toBe(1500);
  });

  /** Items got wrong sort above items that were merely slow. */
  it('ranks what needs work first', () => {
    const s = summarise([
      rep('fast', true, 400),
      rep('slow', true, 4000),
      rep('missed', false, null),
    ]);
    expect(s.byItem.map((row) => row.item.itemId)).toEqual(['missed', 'slow', 'fast']);
  });

  it('reports no median for an item that has never been right', () => {
    const s = summarise([rep('x', false, null), rep('x', false, 900)]);
    const x = s.byItem[0]!;
    expect(x.reps).toBe(2);
    expect(x.correct).toBe(0);
    expect(x.medianLatencyMs).toBeNull();
  });
});
