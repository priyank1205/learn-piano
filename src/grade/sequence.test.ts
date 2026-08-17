/**
 * Tests for the sequence grader.
 *
 * architecture.md section 4 opens the timed rules with "this is where naive
 * implementations feel unfair", and every unfairness it names is a test here: a
 * note played slightly late is late and not wrong; a note played very late is
 * missing and the note that took its place is extra; a tap during the count-in
 * is neither. The user's whole relationship with this drill is whether he
 * believes the number afterwards, and one rep marked wrong for the wrong reason
 * costs more than a whole session of correct grading earns.
 *
 * The other half is the clock. Every expected beat is placed by `gridStartMs`,
 * which comes from the Transport through the calibrated offset, and a constant
 * error there would show up here as a constant `mean` with a small `sd`. That
 * distinction, a bias against a wobble, is the one these tests are built to keep
 * visible.
 */

import { describe, expect, it } from 'vitest';
import { gradeSequence, buildGrid, gridEndsAt, notesPerBeatOf } from './sequence.ts';
import { DEFAULT_TOLERANCES, withTolerances } from './types.ts';
import type { DrillInstance, ExpectedEvent } from './types.ts';
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

const PROMPT_AT = 10_000;
/** Beat 0, well after the prompt: the count-in happens in between. */
const GRID_AT = 12_400;
const BPM = 100;
const BEAT_MS = 60_000 / BPM;
const BEATS = 8;
const PITCH = 60;

/** pr-pulse-sync, right hand at 100: eight quarter notes on C4. */
function pulse(overrides: Partial<DrillInstance> = {}): DrillInstance {
  const events: ExpectedEvent[] = Array.from({ length: BEATS }, (_, beat) => ({
    pitches: [PITCH],
    atBeat: beat,
    hand: 'R' as const,
  }));
  return {
    itemId: 'test:pulse',
    drillId: 'rhythm-tap',
    nodeIds: ['pr-pulse-sync'],
    expected: { tempoBpm: BPM, events },
    grading: {
      graderId: 'sequence',
      pass: { noteAccuracy: 1, meanAbsErrMsMax: 35, timingSdMsMax: 30 },
    },
    constraints: { splitPoint: 60 },
    promptReadyAt: PROMPT_AT,
    gridStartMs: GRID_AT,
    ...overrides,
  };
}

/** Taps at the given error from each beat, in ms. One number per beat. */
function taps(errors: readonly number[], pitch = PITCH): NormalizedEvent[] {
  return errors.map((error, beat) => on(pitch, GRID_AT + beat * BEAT_MS + error));
}

const perfect = () => taps(Array.from({ length: BEATS }, () => 0));

describe('the grid', () => {
  it('places beat 0 at gridStartMs and spaces the rest by the tempo', () => {
    const grid = buildGrid(pulse(), DEFAULT_TOLERANCES);
    expect(grid.slots[0]!.targetTs).toBe(GRID_AT);
    expect(grid.slots[1]!.targetTs).toBe(GRID_AT + BEAT_MS);
    expect(grid.slots).toHaveLength(BEATS);
  });

  /**
   * Section 4: `W = clamp(40, 0.25 * IOI, 120)`. At 100 BPM a quarter note is
   * 600ms, so a quarter of it is over the ceiling and the window is 120ms. The
   * ceiling exists so that a slow tempo cannot forgive rhythm entirely.
   */
  it('sizes the window from the inter-onset interval, capped', () => {
    const grid = buildGrid(pulse(), DEFAULT_TOLERANCES);
    expect(grid.windowMs).toBe(DEFAULT_TOLERANCES.timingWindowCeilMs);
    expect(grid.reachMs).toBe(grid.windowMs * DEFAULT_TOLERANCES.lateFactor);
  });

  it('reads the subdivision off the expected beats', () => {
    expect(
      notesPerBeatOf([
        { pitches: [1], atBeat: 0 },
        { pitches: [1], atBeat: 1 },
      ])
    ).toBe(1);
    expect(
      notesPerBeatOf([
        { pitches: [1], atBeat: 0 },
        { pitches: [1], atBeat: 0.5 },
        { pitches: [1], atBeat: 1 },
      ])
    ).toBe(2);
  });

  it('ends one late window after the last beat', () => {
    const grid = buildGrid(pulse(), DEFAULT_TOLERANCES);
    expect(gridEndsAt(grid)).toBe(GRID_AT + (BEATS - 1) * BEAT_MS + grid.reachMs);
  });
});

describe('a clean pass', () => {
  it('matches every beat and passes', () => {
    const result = gradeSequence(perfect(), pulse());
    expect(result.correct).toBe(true);
    expect(result.perEvent.every((e) => e.status === 'on-time')).toBe(true);
    expect(result.timingErrorMs).toEqual({ mean: 0, meanAbs: 0, sd: 0 });
    expect(result.noteErrors).toEqual({ missing: [], extra: [], wrong: [] });
  });

  /** Timed drills have no latency: the bands do not apply (section 5). */
  it('reports no latency', () => {
    expect(gradeSequence(perfect(), pulse()).latencyMs).toBeNull();
  });

  it('passes a human who is a few milliseconds out', () => {
    const result = gradeSequence(taps([4, -7, 12, -3, 9, -11, 6, 0]), pulse());
    expect(result.correct).toBe(true);
    expect(result.timingErrorMs!.meanAbs).toBeLessThan(35);
  });
});

describe('what must not be called a wrong note', () => {
  /**
   * The single most important case in this file. A note the user played
   * correctly, a little late, is late. Reporting it as a wrong note teaches
   * nothing and is why people stop trusting rhythm software.
   */
  it('flags a note outside the window as late, not wrong', () => {
    const late = DEFAULT_TOLERANCES.timingWindowCeilMs + 40;
    const result = gradeSequence(taps([0, late, 0, 0, 0, 0, 0, 0]), pulse());
    expect(result.perEvent[1]!.status).toBe('late');
    expect(result.noteErrors.wrong).toEqual([]);
    expect(result.noteErrors.missing).toEqual([]);
  });

  it('flags an early one the same way', () => {
    const early = -(DEFAULT_TOLERANCES.timingWindowCeilMs + 40);
    const result = gradeSequence(taps([0, 0, early, 0, 0, 0, 0, 0]), pulse());
    expect(result.perEvent[2]!.status).toBe('early');
    expect(result.noteErrors.wrong).toEqual([]);
  });

  /** The count-in is real time and tapping along with it is what a musician does. */
  it('ignores taps before the grid starts', () => {
    const countIn = [-4, -3, -2, -1].map((beat) => on(PITCH, GRID_AT + beat * BEAT_MS));
    const result = gradeSequence([...countIn, ...perfect()], pulse());
    expect(result.correct).toBe(true);
    expect(result.noteErrors.extra).toEqual([]);
  });

  it('ignores a stray note after the last beat has closed', () => {
    const after = on(PITCH, GRID_AT + BEATS * BEAT_MS + 1000);
    const result = gradeSequence([...perfect(), after], pulse());
    expect(result.correct).toBe(true);
  });

  /**
   * Found by playing it. The grid is scheduled before the prompt is armed, so
   * `promptReadyAt` (which waits for a paint) can land after beat 0 when a frame
   * is slow. The untimed grader is right to discard everything before the prompt
   * appeared; a timed one is bounded by its own grid instead, or a busy frame
   * silently eats the first note of the run and reports it missing.
   */
  it('counts beat 0 even when the prompt was painted after it', () => {
    const result = gradeSequence(perfect(), pulse({ promptReadyAt: GRID_AT + 400 }));
    expect(result.perEvent[0]!.status).toBe('on-time');
    expect(result.noteErrors.missing).toEqual([]);
    expect(result.correct).toBe(true);
  });
});

describe('what must be called wrong', () => {
  it('calls a wrong key in the right place a wrong note', () => {
    const events = perfect();
    events[3] = on(PITCH + 2, GRID_AT + 3 * BEAT_MS);
    const result = gradeSequence(events, pulse());
    expect(result.perEvent[3]!.status).toBe('wrong');
    expect(result.noteErrors.wrong).toEqual([{ expected: PITCH, played: PITCH + 2 }]);
    expect(result.correct).toBe(false);
  });

  it('calls a beat with nothing near it missing', () => {
    const result = gradeSequence(
      perfect().filter((_, i) => i !== 5),
      pulse()
    );
    expect(result.perEvent[5]!.status).toBe('missing');
    expect(result.noteErrors.missing).toEqual([PITCH]);
    expect(result.correct).toBe(false);
  });

  it('calls an unmatched tap inside the grid extra', () => {
    const extra = on(PITCH, GRID_AT + 2 * BEAT_MS + 300);
    const result = gradeSequence([...perfect(), extra], pulse());
    expect(result.noteErrors.extra).toEqual([PITCH]);
    expect(result.perEvent.some((e) => e.status === 'extra')).toBe(true);
    expect(result.correct).toBe(false);
  });

  it('records every expected note as missing when nothing was played', () => {
    const result = gradeSequence([], pulse());
    expect(result.noteErrors.missing).toHaveLength(BEATS);
    expect(result.timingErrorMs).toBeNull();
    expect(result.correct).toBe(false);
  });

  /**
   * Each cluster is consumed once (section 4.5), so a double tap on one beat
   * cannot answer the next one as well.
   */
  it('consumes a cluster once', () => {
    const double = [...perfect(), on(PITCH, GRID_AT + 30)];
    const result = gradeSequence(double, pulse());
    expect(result.noteErrors.extra).toEqual([PITCH]);
  });
});

describe('the pass thresholds', () => {
  it('fails a run that is accurate but drifting', () => {
    // Every note matched and none of them wrong: a rhythm failure, not a note
    // failure, which is the case session-generator.md section 2 rates `hard`.
    const drifting = taps([50, 55, 45, 60, 40, 55, 50, 45]);
    const result = gradeSequence(drifting, pulse());
    expect(result.noteErrors).toEqual({ missing: [], extra: [], wrong: [] });
    expect(result.timingErrorMs!.meanAbs).toBeGreaterThan(35);
    expect(result.correct).toBe(false);
  });

  it('fails a run that is centred but unsteady', () => {
    const unsteady = taps([-60, 60, -55, 55, -50, 50, -45, 45]);
    const result = gradeSequence(unsteady, pulse());
    expect(Math.abs(result.timingErrorMs!.mean)).toBeLessThan(5);
    expect(result.timingErrorMs!.sd).toBeGreaterThan(30);
    expect(result.correct).toBe(false);
  });

  it('passes on identity alone when the drill declares no thresholds', () => {
    const spec = pulse({ grading: { graderId: 'sequence' } });
    const result = gradeSequence(taps([50, 55, 45, 60, 40, 55, 50, 45]), spec);
    expect(result.correct).toBe(true);
  });
});

describe('the clock offset', () => {
  /**
   * CLAUDE.md's clock gotcha, as a grade. A grid origin that is 80ms out because
   * the MIDI-to-audio offset was mishandled turns a perfect run into a failing
   * one, and the signature is unmistakable: a large `mean` beside a tiny `sd`.
   * That is what makes a wrong offset findable instead of a mystery about the
   * user's timing.
   */
  it('shows a mishandled offset as bias, not as wobble', () => {
    const result = gradeSequence(perfect(), pulse({ gridStartMs: GRID_AT - 80 }));
    expect(result.timingErrorMs!.mean).toBeCloseTo(80, 6);
    expect(result.timingErrorMs!.sd).toBeCloseTo(0, 6);
    expect(result.correct).toBe(false);
  });

  it('still grades, and visibly badly, with no grid at all', () => {
    // An authoring bug rather than a performance: audio was never started, so
    // there was no offset to place a grid with and the beats fall from the
    // prompt instead. The rep has to survive that, and it has to look wrong
    // rather than plausible, because a plausible number here would be a lie
    // about the user's timing.
    const spec = pulse({ gridStartMs: undefined });
    const result = gradeSequence(taps([0, 0, 0, 0, 0, 0, 0, 0]), spec);
    expect(result.perEvent).toHaveLength(BEATS);
    expect(result.correct).toBe(false);
    expect(result.noteErrors.missing.length).toBeGreaterThan(0);
  });
});

describe('tolerances', () => {
  it('takes a per-drill override, as the schema allows', () => {
    const tight = pulse({
      grading: {
        graderId: 'sequence',
        tolerances: { timingWindowCeilMs: 30 },
        pass: { noteAccuracy: 1 },
      },
    });
    const grid = buildGrid(tight, withTolerances(tight.grading.tolerances));
    expect(grid.windowMs).toBe(30);
    // 40ms out is on-time under the default ceiling and late under this one.
    const result = gradeSequence(taps([40, 0, 0, 0, 0, 0, 0, 0]), tight);
    expect(result.perEvent[0]!.status).toBe('late');
  });
});
