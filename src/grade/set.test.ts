/**
 * Tests for the set grader.
 *
 * The cases that matter are the unfair ones. A grader that marks a correct
 * answer wrong once a session is worse than no grader: the user stops trusting
 * the numbers, and the numbers are the only reason the app exists. So most of
 * what follows is about what must NOT be punished -- any octave, any striking
 * order, a rolled chord inside the window, notes released in any order -- and
 * about the two things that must be, wrong notes and the wrong bass.
 */

import { describe, expect, it } from 'vitest';
import { gradeSet } from './set.ts';
import { WRONG_INVERSION_SCORE_FACTOR } from './set.ts';
import { DEFAULT_TOLERANCES, LATENCY_BANDS, latencyBand } from './types.ts';
import type { DrillInstance } from './types.ts';
import { triadPitches } from '../theory.ts';
import type { NormalizedEvent } from '../midi.ts';

let seq = 0;

function on(pitch: number, ts: number): NormalizedEvent {
  return {
    type: 'on',
    pitch,
    ts,
    velocity: 100,
    channel: 1,
    statusByte: 0x90,
    raw: [0x90, pitch, 100],
    seq: seq++,
    portId: 'test',
  };
}

function off(pitch: number, ts: number): NormalizedEvent {
  return {
    type: 'off',
    pitch,
    ts,
    velocity: 0,
    releaseVelocity: 64,
    channel: 1,
    statusByte: 0x80,
    raw: [0x80, pitch, 64],
    seq: seq++,
    portId: 'test',
    offSource: 'status-128',
  };
}

const PROMPT_AT = 10_000;

/** Db/F, first inversion: the archetypal item of the core V1 node. */
function dbFirstInversion(overrides: Partial<DrillInstance> = {}): DrillInstance {
  return {
    itemId: 'test:Db:maj:1',
    drillId: 'inversion-trainer',
    nodeIds: ['kt-inv-maj-triads'],
    expected: {
      events: [{ pitches: triadPitches('Db', 'maj', 1), bassPc: 5 }],
    },
    grading: { graderId: 'set' },
    constraints: { octaveEquivalent: true, inversionStrict: true },
    promptReadyAt: PROMPT_AT,
    ...overrides,
  };
}

/** Play a chord as one cluster, `after` ms into the rep. */
function chord(pitches: number[], after: number, spreadMs = 0): NormalizedEvent[] {
  const step = pitches.length > 1 ? spreadMs / (pitches.length - 1) : 0;
  return pitches.map((p, i) => on(p, PROMPT_AT + after + i * step));
}

describe('a correct answer', () => {
  it('grades the expected chord as correct', () => {
    const result = gradeSet(chord([53, 56, 61], 900), dbFirstInversion());
    expect(result.correct).toBe(true);
    expect(result.score).toBe(1);
    expect(result.noteErrors).toEqual({ missing: [], extra: [], wrong: [] });
    expect(result.perEvent[0]!.status).toBe('matched');
  });

  it('accepts the chord an octave up, because the drill is octave-equivalent', () => {
    expect(gradeSet(chord([65, 68, 73], 900), dbFirstInversion()).correct).toBe(true);
  });

  it('does not care in what order the notes were struck', () => {
    const events = [
      on(61, PROMPT_AT + 900),
      on(53, PROMPT_AT + 910),
      on(56, PROMPT_AT + 920),
    ];
    expect(gradeSet(events, dbFirstInversion()).correct).toBe(true);
  });

  it('does not care when or in what order the keys were released', () => {
    const events = [
      ...chord([53, 56, 61], 900),
      off(56, PROMPT_AT + 1200),
      off(53, PROMPT_AT + 1400),
      off(61, PROMPT_AT + 3000),
    ];
    expect(gradeSet(events, dbFirstInversion()).correct).toBe(true);
  });

  it('accepts a rolled chord inside the cluster window and records the roll', () => {
    const result = gradeSet(chord([53, 56, 61], 900, 60), dbFirstInversion());
    expect(result.correct).toBe(true);
    expect(result.spreadMsMax).toBe(60);
  });

  it('accepts a doubled note', () => {
    // The same chord with the bass doubled an octave up: still the same set.
    expect(gradeSet(chord([53, 56, 61, 65], 900), dbFirstInversion()).correct).toBe(true);
  });
});

describe('latency', () => {
  /**
   * Measured to the LAST note of the chord, not the first. The prompt has not
   * been answered until the whole shape is down, and measuring to the first
   * note would let a slow arpeggiation read as an automatic answer.
   */
  it('runs from prompt ready to the last note of the chord', () => {
    const result = gradeSet(chord([53, 56, 61], 900, 60), dbFirstInversion());
    expect(result.latencyMs).toBe(960);
  });

  it('lands in the band the scheduler will read', () => {
    const fast = gradeSet(chord([53, 56, 61], 800), dbFirstInversion());
    const middling = gradeSet(chord([53, 56, 61], 2000), dbFirstInversion());
    const slow = gradeSet(chord([53, 56, 61], 4000), dbFirstInversion());
    expect(latencyBand(fast.latencyMs)).toBe('automatic');
    expect(latencyBand(middling.latencyMs)).toBe('known');
    expect(latencyBand(slow.latencyMs)).toBe('not-known');
  });

  it('puts the band edges exactly where the tree says', () => {
    expect(latencyBand(LATENCY_BANDS.automaticMs - 1)).toBe('automatic');
    expect(latencyBand(LATENCY_BANDS.automaticMs)).toBe('known');
    expect(latencyBand(LATENCY_BANDS.knownMs)).toBe('known');
    expect(latencyBand(LATENCY_BANDS.knownMs + 1)).toBe('not-known');
    expect(latencyBand(null)).toBeNull();
  });
});

describe('wrong answers', () => {
  it('reports a substituted note as a substitution, not as one missing and one extra', () => {
    // D natural where Db was expected.
    const result = gradeSet(chord([53, 56, 62], 900), dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.noteErrors.wrong).toEqual([{ expected: 1, played: 2 }]);
    expect(result.noteErrors.missing).toEqual([]);
    expect(result.noteErrors.extra).toEqual([]);
  });

  it('reports an added note as extra', () => {
    const result = gradeSet(chord([53, 56, 61, 60], 900), dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.noteErrors.extra).toEqual([0]);
  });

  it('reports a dropped note as missing', () => {
    const result = gradeSet(chord([53, 56], 900), dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.noteErrors.missing).toEqual([1]);
  });

  it('scores a near miss above a wrong chord', () => {
    const nearMiss = gradeSet(chord([53, 56, 62], 900), dbFirstInversion()).score;
    const wrongChord = gradeSet(chord([55, 59, 62], 900), dbFirstInversion()).score;
    expect(nearMiss).toBeGreaterThan(wrongChord);
  });
});

describe('inversionStrict', () => {
  it('fails the right notes over the wrong bass', () => {
    // Db major in root position when Db/F was asked for.
    const result = gradeSet(chord([49, 53, 56], 900), dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.perEvent[0]!.status).toBe('wrong-inversion');
    // The notes themselves were right, so nothing is reported as a note error.
    expect(result.noteErrors).toEqual({ missing: [], extra: [], wrong: [] });
    expect(result.score).toBeCloseTo(WRONG_INVERSION_SCORE_FACTOR, 9);
  });

  it('accepts any bass when the drill does not declare it', () => {
    const spec = dbFirstInversion({ constraints: { octaveEquivalent: true } });
    expect(gradeSet(chord([49, 53, 56], 900), spec).correct).toBe(true);
  });

  /**
   * The bass is the lowest KEY, not the lowest note of the named chord. Playing
   * Db/F with the F above the Ab is a second inversion by ear and must fail.
   */
  it('reads the bass from the lowest key actually played', () => {
    const result = gradeSet(chord([56, 61, 65], 900), dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.perEvent[0]!.status).toBe('wrong-inversion');
  });
});

describe('what counts as the answer', () => {
  it('ignores notes played before the prompt appeared', () => {
    const events = [on(60, PROMPT_AT - 500), ...chord([53, 56, 61], 900)];
    const result = gradeSet(events, dbFirstInversion());
    expect(result.correct).toBe(true);
    expect(result.raw).toHaveLength(3);
  });

  it('waits rather than grading a chord that has not settled', () => {
    const events = chord([53, 56, 61], 900);
    const stillPlaying = gradeSet(events, dbFirstInversion(), {
      nowMs: PROMPT_AT + 900 + DEFAULT_TOLERANCES.settleMs - 1,
    });
    expect(stillPlaying.latencyMs).toBeNull();
    expect(stillPlaying.correct).toBe(false);
  });

  it('grades once the settle window has passed', () => {
    const events = chord([53, 56, 61], 900);
    const settled = gradeSet(events, dbFirstInversion(), {
      nowMs: PROMPT_AT + 900 + DEFAULT_TOLERANCES.settleMs,
    });
    expect(settled.correct).toBe(true);
  });

  /**
   * The harshest consequence of the tolerances, and the one to watch in week
   * one. A chord placed one note at a time, 100ms apart, is three clusters
   * rather than one; none of the first two is followed by enough silence to
   * settle, so the answer graded is the final NOTE, and the report reads
   * "missing two notes" rather than "you rolled it".
   *
   * That is architecture.md section 4 applied literally, and it is why
   * chordClusterMs is overridable per drill and why the bench shows the roll
   * next to the grade. If a real session produces this, the number is wrong,
   * not the playing (architecture.md section 9).
   */
  it('grades a chord rolled past the cluster window as its last note', () => {
    const events = chord([53, 56, 61], 900, 200);
    const result = gradeSet(events, dbFirstInversion());
    expect(result.correct).toBe(false);
    // Db, the top note of the roll, alone.
    expect(result.perEvent[0]!.played).toEqual([1]);
    expect(result.noteErrors.missing).toEqual([5, 8]);
  });

  it('accepts that same roll when the drill widens the window', () => {
    const events = chord([53, 56, 61], 900, 200);
    const spec = dbFirstInversion({
      grading: { graderId: 'set', tolerances: { chordClusterMs: 250 } },
    });
    expect(gradeSet(events, spec).correct).toBe(true);
  });

  it('records a miss when nothing was played', () => {
    const result = gradeSet([], dbFirstInversion());
    expect(result.correct).toBe(false);
    expect(result.latencyMs).toBeNull();
    expect(result.noteErrors.missing).toEqual([1, 5, 8]);
    expect(result.perEvent[0]!.status).toBe('missing');
  });

  it('keeps the raw events so the rep can be re-graded later', () => {
    const events = [...chord([53, 56, 61], 900), off(53, PROMPT_AT + 1500)];
    expect(gradeSet(events, dbFirstInversion()).raw).toHaveLength(4);
  });
});

describe('drills that are not octave-equivalent', () => {
  const noteFind = (pitch: number): DrillInstance => ({
    itemId: 'test:note-find',
    drillId: 'note-find',
    nodeIds: ['kt-geography'],
    expected: { events: [{ pitches: [pitch] }] },
    grading: { graderId: 'set' },
    constraints: {},
    promptReadyAt: PROMPT_AT,
  });

  it('requires the exact pitch', () => {
    expect(gradeSet(chord([60], 500), noteFind(60)).correct).toBe(true);
    expect(gradeSet(chord([72], 500), noteFind(60)).correct).toBe(false);
  });

  it('applies the app transpose to the expectation, not to the playing', () => {
    const shifted: DrillInstance = {
      ...noteFind(60),
      constraints: { octaveShiftAllowed: true },
      transposeOffset: 12,
    };
    expect(gradeSet(chord([72], 500), shifted).correct).toBe(true);
    expect(gradeSet(chord([60], 500), shifted).correct).toBe(false);
  });

  it('ignores the transpose when the drill does not allow the shift', () => {
    const pinned: DrillInstance = { ...noteFind(60), transposeOffset: 12 };
    expect(gradeSet(chord([60], 500), pinned).correct).toBe(true);
  });
});

describe('an empty expectation', () => {
  it('reports a failure instead of throwing inside a grader', () => {
    const spec = dbFirstInversion({ expected: { events: [] } });
    const result = gradeSet(chord([53, 56, 61], 900), spec);
    expect(result.correct).toBe(false);
    expect(result.perEvent).toEqual([]);
  });
});
