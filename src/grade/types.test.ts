/**
 * Tests for the tolerance and band configuration.
 *
 * These do not test behaviour, they test that the app and its specification
 * still agree. Every number here was chosen in a document, and the failure mode
 * is not a crash: it is the app quietly grading against 100ms when
 * architecture.md says 80, forever, with plausible-looking scores.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCES,
  DEFAULT_WEIGHTS,
  LATENCY_BANDS,
  ioiMs,
  timingWindowMs,
  withTolerances,
} from './types.ts';
import tree from '../../docs/skill-tree.json';

describe('agreement with the design documents', () => {
  it('uses the tolerances from architecture.md section 4', () => {
    expect(DEFAULT_TOLERANCES.chordClusterMs).toBe(80);
    expect(DEFAULT_TOLERANCES.settleMs).toBe(300);
    expect(DEFAULT_TOLERANCES.lateFactor).toBe(2);
    expect(DEFAULT_TOLERANCES.legatoBandMs).toEqual([10, 60]);
    expect(DEFAULT_TOLERANCES.detachedGapMs).toBe(-20);
    expect(DEFAULT_TOLERANCES.smearMs).toBe(120);
    expect(DEFAULT_TOLERANCES.staccatoDuty).toEqual([0.3, 0.5]);
  });

  it('uses the weights from architecture.md section 2', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ identity: 0.6, timing: 0.25, articulation: 0.15 });
  });

  /**
   * The tree is the curriculum and carries the same two numbers in its meta
   * block. Two copies of a threshold is one too many; this is the guard that
   * they never drift.
   */
  it('uses the latency bands the skill tree declares', () => {
    expect(LATENCY_BANDS.automaticMs).toBe(tree.meta.latencyBandsMs.automatic);
    expect(LATENCY_BANDS.knownMs).toBe(tree.meta.latencyBandsMs.known);
  });

  it('splits hands at the split point the tree assumes', () => {
    expect(tree.meta.instrument.channel).toContain('60');
  });
});

describe('timingWindowMs', () => {
  it('scales with tempo through the inter-onset interval', () => {
    // 100 BPM quarters: 600ms IOI, quarter of that is 150, clamped to 120.
    expect(timingWindowMs(ioiMs(100, 1))).toBe(120);
    // 120 BPM eighths: 250ms IOI, quarter of that is 62.5, inside the clamp.
    expect(timingWindowMs(ioiMs(120, 2))).toBeCloseTo(62.5, 9);
  });

  it('floors below human relevance', () => {
    // Very fast material would otherwise demand single-digit-ms accuracy.
    expect(timingWindowMs(40)).toBe(40);
  });

  it('caps so a slow tempo cannot forgive rhythm entirely', () => {
    expect(timingWindowMs(10_000)).toBe(120);
  });
});

describe('withTolerances', () => {
  it('returns the defaults untouched when nothing is overridden', () => {
    expect(withTolerances()).toBe(DEFAULT_TOLERANCES);
  });

  it('overrides one number without disturbing the rest', () => {
    const tol = withTolerances({ chordClusterMs: 250 });
    expect(tol.chordClusterMs).toBe(250);
    expect(tol.settleMs).toBe(DEFAULT_TOLERANCES.settleMs);
    expect(DEFAULT_TOLERANCES.chordClusterMs).toBe(80);
  });
});
