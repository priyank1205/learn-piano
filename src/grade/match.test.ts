/**
 * Tests for note comparison and scoring.
 *
 * The pairing rule is what makes wrong-note feedback readable. Reporting "you
 * are missing Ab and you played an extra G" is true and useless; "you played G
 * where Ab was expected" is the same fact in the form the user can act on.
 */

import { describe, expect, it } from 'vitest';
import {
  diffNotes,
  identityScore,
  isClean,
  pitchDistance,
  weightedScore,
} from './match.ts';
import { DEFAULT_WEIGHTS } from './types.ts';

describe('pitchDistance', () => {
  it('measures absolute semitones by default', () => {
    expect(pitchDistance(60, 67, false)).toBe(7);
  });

  /**
   * In pitch-class space there is no "up", so B is one semitone from C rather
   * than eleven. Without this, an octave-equivalent drill pairs a wrong B with
   * a distant expected note and blames the wrong finger.
   */
  it('wraps around the octave in pitch-class space', () => {
    expect(pitchDistance(11, 0, true)).toBe(1);
    expect(pitchDistance(0, 11, true)).toBe(1);
    expect(pitchDistance(0, 6, true)).toBe(6);
  });
});

describe('diffNotes', () => {
  it('reports nothing when the sets match', () => {
    const errors = diffNotes([1, 5, 8], [1, 5, 8]);
    expect(isClean(errors)).toBe(true);
  });

  it('pairs a substitution instead of reporting two separate faults', () => {
    // G played where Ab was expected.
    expect(diffNotes([1, 5, 8], [1, 5, 7])).toEqual({
      missing: [],
      extra: [],
      wrong: [{ expected: 8, played: 7 }],
    });
  });

  it('pairs by nearest pitch when several notes are wrong', () => {
    const errors = diffNotes([0, 4, 7], [1, 5, 8]);
    expect(errors.wrong).toEqual([
      { expected: 0, played: 1 },
      { expected: 4, played: 5 },
      { expected: 7, played: 8 },
    ]);
  });

  it('leaves a genuinely absent note missing', () => {
    expect(diffNotes([1, 5, 8], [1, 5])).toEqual({
      missing: [8],
      extra: [],
      wrong: [],
    });
  });

  it('leaves a genuinely added note extra', () => {
    expect(diffNotes([1, 5, 8], [1, 5, 8, 11])).toEqual({
      missing: [],
      extra: [11],
      wrong: [],
    });
  });

  it('pairs what it can and reports the remainder', () => {
    const errors = diffNotes([0, 4, 7], [1]);
    expect(errors.wrong).toEqual([{ expected: 0, played: 1 }]);
    expect(errors.missing).toEqual([4, 7]);
    expect(errors.extra).toEqual([]);
  });

  it('is deterministic when two pairings are equally near', () => {
    // B is one semitone from both C above and Bb below.
    const first = diffNotes([0, 4, 7], [11, 4, 7], true);
    const second = diffNotes([0, 4, 7], [11, 4, 7], true);
    expect(first).toEqual(second);
    expect(first.wrong).toEqual([{ expected: 0, played: 11 }]);
  });
});

describe('identityScore', () => {
  it('is 1 for a match and 0 for no overlap', () => {
    expect(identityScore([1, 5, 8], [1, 5, 8])).toBe(1);
    expect(identityScore([0, 4, 7], [1, 5, 8])).toBe(0);
  });

  it('drops less for one wrong note than for a wrong chord', () => {
    expect(identityScore([1, 5, 8], [1, 5, 7])).toBeGreaterThan(
      identityScore([1, 5, 8], [0, 4, 7])
    );
  });

  it('penalises an extra note as well as a missing one', () => {
    expect(identityScore([1, 5, 8], [1, 5, 8, 11])).toBeLessThan(1);
  });
});

describe('weightedScore', () => {
  /**
   * An untimed drill has no grid and no articulation to measure. Without
   * renormalisation a perfect flashcard answer would score 0.6 and the UI would
   * report the user's best possible performance as a B.
   */
  it('renormalises over the components a drill can actually produce', () => {
    expect(weightedScore({ identity: 1 })).toBe(1);
    expect(weightedScore({ identity: 0.5 })).toBe(0.5);
  });

  it('weights components in the documented proportion when all are present', () => {
    const score = weightedScore({ identity: 1, timing: 0, articulation: 0 });
    expect(score).toBeCloseTo(DEFAULT_WEIGHTS.identity, 9);
  });

  it('ignores a component that was not measured', () => {
    expect(weightedScore({ identity: 1, timing: undefined })).toBe(1);
  });

  it('is 0 when nothing was measured at all', () => {
    expect(weightedScore({})).toBe(0);
  });
});
