/**
 * The legato grader (architecture.md sections 5 and 7).
 *
 * Every rep here is built from note-ons and note-offs at chosen timestamps,
 * which is the whole point: the measurement is `off(n) - on(n+1)` and nothing
 * else, so a test that cannot state an overlap in milliseconds is not testing
 * this grader.
 *
 * The reps are nine notes at 72 BPM in eighths, which is the shape of the drill
 * the grader was built for, so the grid, the window and the transition count are
 * the real ones rather than convenient ones.
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../midi.ts';
import { legatoLine, legatoPitches } from '../drills/legato.ts';
import { legatoOf } from '../tree.ts';
import {
  analyseOverlap,
  classifyOverlap,
  gradeLegato,
  legatoFinished,
  pairNotes,
  summariseOverlap,
} from './legato.ts';
import { DEFAULT_TOLERANCES, withTolerances } from './types.ts';
import type { DrillInstance } from './types.ts';

const GRID_START = 10_000;
const BEAT_MS = 60_000 / 72;
/** Two notes a beat. */
const STEP_MS = BEAT_MS / 2;

const PARAMS = { hand: 'R', key: 'C' } as const;
const PITCHES = legatoPitches(PARAMS);

function spec(overrides: Partial<DrillInstance> = {}): DrillInstance {
  return {
    itemId: 'legato-test',
    drillId: legatoLine.id,
    nodeIds: ['pr-legato-5finger'],
    expected: legatoLine.buildExpected(PARAMS),
    grading: legatoLine.grading,
    constraints: legatoLine.constraints,
    promptReadyAt: GRID_START - 3000,
    gridStartMs: GRID_START,
    ...overrides,
  };
}

let seq = 0;
const on = (pitch: number, ts: number): NormalizedEvent => ({
  type: 'on',
  pitch,
  ts,
  velocity: 100,
  channel: 1,
  statusByte: 0x90,
  raw: [0x90, pitch, 100],
  seq: seq++,
  portId: 'test',
});
const off = (pitch: number, ts: number): NormalizedEvent => ({
  type: 'off',
  pitch,
  ts,
  velocity: 0,
  releaseVelocity: 64,
  channel: 1,
  statusByte: 0x80,
  raw: [0x80, pitch, 64],
  seq: seq++,
  offSource: 'status-128',
  portId: 'test',
});

interface PlayOptions {
  /** Move note i's onset off the grid. Overlaps are preserved either side of it. */
  onShiftMs?: (i: number) => number;
  /** Substitute the pitch of note i. */
  pitchOf?: (pitch: number, i: number) => number;
}

/**
 * One rep, with every release landing `overlapMs` after the next note started.
 * A positive number is overlap, which is legato.
 *
 * Notes are addressed by **index, never by pitch**: the contour goes up and back
 * down, so five of the nine pitches occur twice and a test that says "the F"
 * silently means two notes. That is a property of the drill rather than of this
 * helper, and the first draft of these tests got it wrong.
 */
function play(
  overlapMs: number | ((i: number) => number),
  opts: PlayOptions = {}
): NormalizedEvent[] {
  const overlapOf = typeof overlapMs === 'function' ? overlapMs : () => overlapMs;
  const shift = opts.onShiftMs ?? (() => 0);
  const pitchOf = opts.pitchOf ?? ((pitch: number) => pitch);

  const onsets = PITCHES.map((_, i) => GRID_START + i * STEP_MS + shift(i));
  const events: NormalizedEvent[] = [];

  PITCHES.forEach((pitch, i) => {
    const played = pitchOf(pitch, i);
    events.push(on(played, onsets[i]!));
    // The release of note i is placed relative to the onset of note i+1, which
    // is exactly what the grader measures. Shifting an onset therefore carries
    // the overlap with it rather than turning it into a gap.
    const offTs =
      i === PITCHES.length - 1 ? onsets[i]! + STEP_MS : onsets[i + 1]! + overlapOf(i);
    events.push(off(played, offTs));
  });

  return events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

describe('classifying one overlap', () => {
  const tol = DEFAULT_TOLERANCES;

  it('reads architecture.md section 5s five bands off the tolerances', () => {
    expect(classifyOverlap(-30, tol)).toBe('detached');
    expect(classifyOverlap(-5, tol)).toBe('near-legato');
    expect(classifyOverlap(35, tol)).toBe('in-band');
    expect(classifyOverlap(90, tol)).toBe('smeared');
    expect(classifyOverlap(200, tol)).toBe('held-over');
  });

  it('puts both edges of the band inside it', () => {
    expect(classifyOverlap(10, tol)).toBe('in-band');
    expect(classifyOverlap(60, tol)).toBe('in-band');
    expect(classifyOverlap(9.9, tol)).toBe('near-legato');
    expect(classifyOverlap(60.1, tol)).toBe('smeared');
  });

  /**
   * The reason the band is a setting: architecture.md section 9.1 says it was
   * calibrated off one captured log and that the fix, if it is wrong, is to move
   * the edges to the user's own p25/p75 and walk them back over sessions. The
   * captured log shows ~60ms overlaps, so under a widened band the same playing
   * that sits at the smeared edge of [10, 60] is comfortably inside [0, 80].
   */
  it('moves with the band, which is what makes stage 1 reachable', () => {
    const stageOne = withTolerances({ legatoBandMs: [0, 80] });
    expect(classifyOverlap(70, DEFAULT_TOLERANCES)).toBe('smeared');
    expect(classifyOverlap(70, stageOne)).toBe('in-band');
  });
});

describe('pairing notes with their releases', () => {
  it('closes the oldest open note of a re-struck pitch first', () => {
    const notes = pairNotes([on(60, 0), on(60, 50), off(60, 100), off(60, 200)]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ onTs: 0, offTs: 100 });
    expect(notes[1]).toMatchObject({ onTs: 50, offTs: 200 });
  });

  it('leaves a note with no release open rather than inventing one', () => {
    const notes = pairNotes([on(60, 0), on(62, 10), off(62, 40)]);
    expect(notes[0]!.offTs).toBeNull();
    expect(notes[1]!.offTs).toBe(40);
  });

  it('ignores a note-off with nothing open', () => {
    expect(pairNotes([off(60, 0)])).toHaveLength(0);
  });
});

describe('measuring one rep', () => {
  it('finds eight transitions in a nine-note line', () => {
    const analysis = analyseOverlap(play(35), spec());
    expect(analysis.transitions).toBe(8);
    expect(analysis.byHand).toHaveLength(1);
    expect(analysis.byHand[0]!.hand).toBe('R');
    expect(analysis.byHand[0]!.transitions).toHaveLength(8);
  });

  it('measures off(n) - on(n+1), signed', () => {
    for (const overlap of [-40, 0, 35, 140]) {
      const analysis = analyseOverlap(play(overlap), spec());
      for (const t of analysis.detail) expect(t.overlapMs).toBeCloseTo(overlap, 6);
    }
  });

  it('reports the share inside the band and the classes either side', () => {
    // Four in band, four smeared.
    const analysis = analyseOverlap(
      play((i) => (i % 2 === 0 ? 30 : 90)),
      spec()
    );
    expect(analysis.inBand).toBe(4);
    expect(analysis.inBandShare).toBe(0.5);
    expect(analysis.counts.smeared).toBe(4);
    expect(analysis.counts.detached).toBe(0);
  });

  /**
   * The whole reason the drill exists, and the thing the instrument's own
   * sustain hides: a hand that lets go early sounds identical through the
   * keyboard's speakers and is plainly detached in the MIDI stream.
   */
  it('calls an early release detached, however good it sounds', () => {
    const analysis = analyseOverlap(play(-60), spec());
    expect(analysis.counts.detached).toBe(8);
    expect(analysis.inBandShare).toBe(0);
  });

  it('supplies section 9.1s recalibration inputs over the rep', () => {
    const analysis = analyseOverlap(
      play((i) => 10 * i),
      spec()
    );
    // Overlaps 0, 10, .. 70.
    expect(analysis.medianMs).toBeCloseTo(35, 6);
    expect(analysis.p25Ms).toBeCloseTo(17.5, 6);
    expect(analysis.p75Ms).toBeCloseTo(52.5, 6);
  });

  /**
   * A note that is never released has no `off(n)`, so its transition has a lower
   * bound rather than a value. Dropping it would flatter exactly the failure the
   * drill is for, so it is held over by definition.
   */
  it('calls an unreleased note held over rather than dropping it', () => {
    // The top of the contour, which is the one pitch that occurs once: a missing
    // release on any other would be absorbed by its twin. See the test below.
    const top = PITCHES[4]!;
    const events = play(35).filter((e) => !(e.type === 'off' && e.pitch === top));
    const analysis = analyseOverlap(events, spec());
    const held = analysis.detail[4]!;
    expect(held.unreleased).toBe(true);
    expect(held.klass).toBe('held-over');
    expect(analysis.counts['held-over']).toBe(1);
  });

  /**
   * MIDI has no note identity: a note-off carries a pitch and nothing else. When
   * one pitch is down twice - and this contour plays five of its nine pitches
   * twice - the only defensible pairing is the oldest open one first, and the
   * consequence is worth knowing before it surprises someone reading a rep. A
   * missing release on the way up is absorbed by the same key's release on the
   * way down, and the transition is reported held over from that later release
   * rather than as unmeasured. Which is the same verdict by a different route,
   * and the honest one: as far as the stream is concerned, that key was down.
   */
  it('absorbs a missing release into the same pitchs next one', () => {
    const events = play(35).filter(
      (e) =>
        !(e.type === 'off' && e.pitch === PITCHES[0] && e.ts < GRID_START + STEP_MS * 4)
    );
    const analysis = analyseOverlap(events, spec());
    const first = analysis.detail[0]!;
    expect(first.unreleased).toBe(false);
    expect(first.klass).toBe('held-over');
    expect(first.overlapMs).toBeGreaterThan(STEP_MS * 7);
    expect(analysis.counts['held-over']).toBe(1);
  });

  it('ignores a note struck before the grid opens', () => {
    const stray = [on(72, GRID_START - 2000), off(72, GRID_START - 1900)];
    const analysis = analyseOverlap([...stray, ...play(35)], spec());
    expect(analysis.transitions).toBe(8);
  });

  it('keeps the hands apart by pitch, which is the only split there is', () => {
    const left = analyseOverlap(
      play(35).map((e) => ({ ...e, pitch: e.pitch - 24 })),
      spec({ expected: legatoLine.buildExpected({ hand: 'L', key: 'C' }) })
    );
    expect(left.byHand).toHaveLength(1);
    expect(left.byHand[0]!.hand).toBe('L');
  });
});

describe('summarising stored overlaps', () => {
  it('re-reads the same rep against a different band without re-grading', () => {
    const byHand = [{ hand: 'R' as const, transitions: [70, 70, 70, 70] }];
    expect(summariseOverlap(byHand, DEFAULT_TOLERANCES).inBandShare).toBe(0);
    expect(
      summariseOverlap(byHand, withTolerances({ legatoBandMs: [0, 80] })).inBandShare
    ).toBe(1);
  });

  it('is zero over an empty sample rather than NaN', () => {
    const empty = summariseOverlap([]);
    expect(empty.inBandShare).toBe(0);
    expect(empty.medianMs).toBeNull();
  });
});

describe('grading one rep', () => {
  const threshold = legatoOf('pr-legato-5finger')!;

  it('passes clean notes with the share met', () => {
    const result = gradeLegato(play(35), spec());
    expect(result.correct).toBe(true);
    expect(result.noteOverlapMs).not.toBeNull();
    expect(result.noteErrors.missing).toEqual([]);
  });

  /**
   * architecture.md section 7: "clean notes AND inBandShare met". Both halves,
   * and this is the half that is new. The notes are perfect and the hand is
   * smearing every one of them.
   */
  it('fails clean notes that miss the share', () => {
    const result = gradeLegato(play(90), spec());
    expect(result.correct).toBe(false);
    expect(result.noteErrors.missing).toEqual([]);
    expect(result.noteErrors.wrong).toEqual([]);
  });

  it('fails the share by one transition and passes at the threshold', () => {
    // Eight transitions, share 0.85: seven in band passes, six does not.
    const sevenOfEight = gradeLegato(
      play((i) => (i === 0 ? 90 : 35)),
      spec()
    );
    const sixOfEight = gradeLegato(
      play((i) => (i < 2 ? 90 : 35)),
      spec()
    );
    expect(7 / 8).toBeGreaterThanOrEqual(threshold.inBandShare);
    expect(6 / 8).toBeLessThan(threshold.inBandShare);
    expect(sevenOfEight.correct).toBe(true);
    expect(sixOfEight.correct).toBe(false);
  });

  it('fails a wrong note however well connected it was', () => {
    const events = play(35, { pitchOf: (pitch, i) => (i === 2 ? pitch + 1 : pitch) });
    const result = gradeLegato(events, spec());
    expect(result.correct).toBe(false);
    expect(result.noteErrors.wrong.length).toBeGreaterThan(0);
  });

  /**
   * Legato is about releases, not onsets. A note inside the late window is still
   * matched by the sequence half, and this grader has no opinion about how late
   * it was - only about whether the hand stayed joined across it.
   *
   * Which means the previous note's release has to move with it. That is not a
   * contrivance, it is the measurement: a note played late with the previous one
   * released on time is a gap, and the grader is right to call it one.
   */
  it('does not care that a note was late, only when it came up', () => {
    const late = play(35, { onShiftMs: (i) => (i === 3 ? 150 : 0) });
    const result = gradeLegato(late, spec());
    expect(result.perEvent[3]!.status).toBe('late');
    expect(result.noteErrors.missing).toEqual([]);
    expect(result.correct).toBe(true);
  });

  it('is not correct when nothing was played', () => {
    const result = gradeLegato([], spec());
    expect(result.correct).toBe(false);
    expect(result.noteOverlapMs).toEqual([]);
  });

  it('honours a band handed down from settings', () => {
    const widened = spec({
      grading: {
        ...legatoLine.grading,
        tolerances: { legatoBandMs: [0, 80] },
      },
    });
    expect(gradeLegato(play(70), spec()).correct).toBe(false);
    expect(gradeLegato(play(70), widened).correct).toBe(true);
  });

  it('scores all three components, which no other drill in V1 can', () => {
    const good = gradeLegato(play(35), spec());
    const smeared = gradeLegato(play(90), spec());
    expect(good.score).toBeGreaterThan(smeared.score);
    expect(good.score).toBeLessThanOrEqual(1);
  });
});

describe('knowing when the rep is over', () => {
  /**
   * The sequence grader stops at the end of the grid because nothing later can
   * change a match. A release can: waiting one smear-width lets every overlap
   * that is still classifiable arrive, and anything slower is held over anyway.
   */
  it('waits one smear past the grid, unlike the sequence grader', () => {
    const s = spec();
    const lastBeat = GRID_START + 8 * STEP_MS;
    const tol = withTolerances(s.grading.tolerances);
    // The inter-onset interval is the eighth note, not the beat.
    const reach = 0.25 * STEP_MS * tol.lateFactor;

    expect(legatoFinished([], s, { nowMs: lastBeat + reach })).toBe(false);
    expect(legatoFinished([], s, { nowMs: lastBeat + reach + tol.smearMs + 1 })).toBe(
      true
    );
  });

  it('is finished when no clock is given, so a stored rep re-grades', () => {
    expect(legatoFinished([], spec(), {})).toBe(true);
  });
});

describe('a band typed the wrong way round', () => {
  /**
   * Two free-form number inputs sit behind this setting, and a floor typed above
   * the ceiling would otherwise empty the target band and report every join as
   * outside it. Which reads exactly like the hand having got worse.
   */
  it('is read as the range it obviously means', () => {
    const inverted = withTolerances({ legatoBandMs: [60, 10] });
    expect(classifyOverlap(35, inverted)).toBe('in-band');
    expect(classifyOverlap(5, inverted)).toBe('near-legato');
    expect(classifyOverlap(90, inverted)).toBe('smeared');
  });
});
