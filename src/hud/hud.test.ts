/**
 * The chord HUD and the free-play harvest (session-generator.md section 8).
 *
 * Everything here is a fold over MIDI events at chosen timestamps plus a poll at
 * a chosen clock, which is what the two modules were split for: the interesting
 * behaviour is "when did this become a chord" and "when has a chord been slow
 * often enough to say so", and neither needs a browser to answer.
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../midi.ts';
import { triadPitches } from '../theory.ts';
import { itemIdOf } from '../drills/hash.ts';
import { INVERSION_TRAINER_ID } from '../drills/inversionTrainer.ts';
import {
  HARVEST_ALPHA,
  inSchedule,
  newItemState,
  nudgeLatency,
} from '../schedule/srs.ts';
import { LATENCY_BANDS } from '../grade/index.ts';
import {
  CHORD_SETTLE_MS,
  ChordWatcher,
  Harvest,
  HARVEST_MIN_OBSERVATIONS,
  attributableShapes,
  attributeChord,
  shapeKey,
} from './index.ts';

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

const C_MAJOR = triadPitches('C', 'maj', 0); // C3 E3 G3
const F_MAJOR = triadPitches('F', 'maj', 0);
const C_OVER_E = triadPitches('C', 'maj', 1);

/** Press a chord at `ts`, then settle the watcher past the deadline. */
function press(
  watcher: ChordWatcher,
  pitches: readonly number[],
  ts: number,
  spreadMs = 0
) {
  pitches.forEach((pitch, i) => watcher.handle(on(pitch, ts + i * spreadMs)));
  const completedAt = ts + (pitches.length - 1) * spreadMs;
  return watcher.poll(completedAt + CHORD_SETTLE_MS);
}

function lift(watcher: ChordWatcher, pitches: readonly number[], ts: number) {
  pitches.forEach((pitch, i) => watcher.handle(off(pitch, ts + i)));
}

describe('naming what is sounding', () => {
  it('does not call a set a chord until it holds still', () => {
    const w = new ChordWatcher();
    C_MAJOR.forEach((p) => w.handle(on(p, 1000)));
    expect(w.poll(1000 + CHORD_SETTLE_MS - 1)).toBeNull();
    expect(w.poll(1000 + CHORD_SETTLE_MS)).not.toBeNull();
  });

  it('waits for two notes to become three', () => {
    const w = new ChordWatcher();
    w.handle(on(48, 0));
    w.handle(on(52, 10));
    expect(w.poll(10_000)).toBeNull();
    w.handle(on(55, 20));
    expect(w.poll(20 + CHORD_SETTLE_MS)).not.toBeNull();
  });

  /**
   * A grader clusters onsets inside 80ms because a prompt has one answer. A
   * chart chord is rolled, arpeggiated or arrived at a finger at a time, and it
   * is still one chord.
   */
  it('takes a chord rolled far wider than any cluster window', () => {
    const w = new ChordWatcher();
    const change = press(w, C_MAJOR, 1000, 250);
    expect(change).not.toBeNull();
    expect(change!.chord.pitches).toEqual([...C_MAJOR].sort((a, b) => a - b));
    expect(change!.chord.startedAt).toBe(1000);
    expect(change!.chord.completedAt).toBe(1500);
  });

  it('emits a settled chord once, not on every frame', () => {
    const w = new ChordWatcher();
    expect(press(w, C_MAJOR, 1000)).not.toBeNull();
    expect(w.poll(9_000)).toBeNull();
    expect(w.poll(99_000)).toBeNull();
  });

  it('reports the bass, which is what makes it an inversion', () => {
    const w = new ChordWatcher();
    const change = press(w, C_OVER_E, 1000);
    expect(change!.chord.bassPitch).toBe(Math.min(...C_OVER_E));
  });

  it('keeps the held set available for the live readout', () => {
    const w = new ChordWatcher();
    press(w, C_MAJOR, 1000);
    expect(w.held()).toEqual([...C_MAJOR].sort((a, b) => a - b));
    lift(w, C_MAJOR, 2000);
    expect(w.held()).toEqual([]);
  });
});

describe('change latency', () => {
  /**
   * section 8's number, as far as it is observable without a chart: the previous
   * chord came apart, the hand went somewhere, and this chord was complete.
   */
  it('is the gap from the last chord breaking to this one being complete', () => {
    const w = new ChordWatcher();
    press(w, C_MAJOR, 1000);
    lift(w, C_MAJOR, 2000);
    const change = press(w, F_MAJOR, 2700);
    expect(change!.changeLatencyMs).toBe(700);
  });

  it('is null for the first chord, which follows nothing', () => {
    const w = new ChordWatcher();
    expect(press(w, C_MAJOR, 1000)!.changeLatencyMs).toBeNull();
  });

  /**
   * Common tones held across the change mean the previous chord never came
   * apart before this one was complete. There is no hunting to see, and
   * inventing a zero would tell the harvest a hand was fast when it was only
   * connected.
   */
  it('is null when the previous chord was still intact', () => {
    const w = new ChordWatcher();
    press(w, [48, 52, 55], 1000);
    // Add a note without releasing anything: the first chord is still whole.
    w.handle(on(57, 1500));
    const change = w.poll(1500 + CHORD_SETTLE_MS);
    expect(change!.changeLatencyMs).toBeNull();
  });

  it('does not count re-striking the same chord as a change', () => {
    const w = new ChordWatcher();
    press(w, C_MAJOR, 1000);
    lift(w, C_MAJOR, 2000);
    expect(press(w, C_MAJOR, 2800)).toBeNull();
  });

  it('measures from the first release, not the last', () => {
    const w = new ChordWatcher();
    press(w, C_MAJOR, 1000);
    // The hand comes off one finger at a time over 300ms.
    C_MAJOR.forEach((p, i) => w.handle(off(p, 2000 + i * 150)));
    const change = press(w, F_MAJOR, 3000);
    expect(change!.changeLatencyMs).toBe(1000);
  });
});

describe('attributing a chord to an item', () => {
  it('finds the pool item for a triad in root position', () => {
    const item = attributeChord(C_MAJOR);
    expect(item?.itemId).toBe(
      itemIdOf(INVERSION_TRAINER_ID, { rootPc: 0, quality: 'maj', inversion: 0 })
    );
  });

  it('tells inversions apart by the bass, as the grader does', () => {
    expect(attributeChord(C_MAJOR)?.itemId).not.toBe(attributeChord(C_OVER_E)?.itemId);
    expect(attributeChord(C_OVER_E)?.itemId).toBe(
      itemIdOf(INVERSION_TRAINER_ID, { rootPc: 0, quality: 'maj', inversion: 1 })
    );
  });

  /** Real playing doubles the root. The shape is the pitch classes and the bass. */
  it('matches a voicing with a doubled root an octave up', () => {
    const doubled = [...C_MAJOR, C_MAJOR[0]! + 12];
    expect(attributeChord(doubled)?.itemId).toBe(attributeChord(C_MAJOR)?.itemId);
  });

  it('covers all 72 triads the inversion trainer declares, and nothing else', () => {
    expect(attributableShapes()).toBe(72);
  });

  it('has nothing to say about a chord no drill declares', () => {
    // A dominant seventh: real music, and not in the V1 pool.
    expect(attributeChord([48, 52, 55, 58])).toBeUndefined();
    expect(attributeChord([60, 62])).toBeUndefined();
  });

  it('keys on pitch classes and the bass pitch class', () => {
    expect(shapeKey([48, 52, 55], 0)).toBe('0,4,7/0');
    expect(shapeKey([60, 64, 67], 0)).toBe('0,4,7/0');
  });
});

describe('deciding a chord is consistently slow', () => {
  it('says nothing until it has seen enough of one item', () => {
    const h = new Harvest();
    for (let i = 1; i < HARVEST_MIN_OBSERVATIONS; i += 1) {
      expect(h.observe('item', 'C', 2000)).toBeNull();
    }
    expect(h.observe('item', 'C', 2000)).not.toBeNull();
  });

  it('reports the median, so one fumble cannot carry an item', () => {
    const h = new Harvest();
    h.observe('item', 'C', 900);
    h.observe('item', 'C', 950);
    const nudge = h.observe('item', 'C', 9000);
    expect(nudge!.medianMs).toBe(950);
    expect(nudge!.observations).toBe(3);
  });

  it('counts items separately', () => {
    const h = new Harvest();
    h.observe('a', 'C', 1000);
    h.observe('a', 'C', 1000);
    expect(h.observe('b', 'F', 1000)).toBeNull();
    expect(h.observe('a', 'C', 1000)).not.toBeNull();
    expect(h.size).toBe(2);
  });

  it('ignores a latency that is not a positive number', () => {
    const h = new Harvest();
    for (const bad of [0, -100, NaN, Infinity]) {
      expect(h.observe('item', 'C', bad)).toBeNull();
    }
    expect(h.size).toBe(0);
  });

  it('lists what it saw, slowest first', () => {
    const h = new Harvest();
    h.observe('a', 'C', 1000);
    h.observe('b', 'F', 4000);
    expect(h.rows().map((r) => r.itemId)).toEqual(['b', 'a']);
  });
});

/**
 * The other half of section 8, which is the half with teeth: what the nudge is
 * allowed to do to an item.
 */
describe('nudging an items latency', () => {
  const NOW = 1_700_000_000_000;
  const fresh = () => newItemState('item', ['kt-triads-root'], NOW);

  it('moves latEMA and nothing else', () => {
    const before = { ...fresh(), reps: 4, latEMA: 1500, accEMA: 0.9 };
    const after = nudgeLatency(before, 3000, NOW + 60_000);

    expect(after.latEMA).toBeCloseTo(1500 + HARVEST_ALPHA * (3000 - 1500), 6);
    expect(after.reps).toBe(before.reps);
    expect(after.accEMA).toBe(before.accEMA);
    expect(after.dueAt).toBe(before.dueAt);
    expect(after.status).toBe(before.status);
    expect(after.history).toEqual(before.history);
    expect(after.lapses).toBe(before.lapses);
  });

  /**
   * "Chords whose change latency is consistently **slow** get their items'
   * latEMA nudged." Free play is unprompted, so a fast observation is not
   * evidence of anything: nobody was being timed. Upward-only is what keeps the
   * HUD from being a way to flatter an item without answering a prompt.
   */
  it('only ever goes up', () => {
    const known = { ...fresh(), reps: 4, latEMA: 1500 };
    expect(nudgeLatency(known, 400, NOW)).toBe(known);
    expect(nudgeLatency(known, 1500, NOW)).toBe(known);
    expect(nudgeLatency(known, 1501, NOW).latEMA).toBeGreaterThan(1500);
  });

  it('will not seed an unpractised item from below the automatic band', () => {
    const unpractised = fresh();
    expect(nudgeLatency(unpractised, LATENCY_BANDS.automaticMs - 1, NOW)).toBe(
      unpractised
    );
    const seeded = nudgeLatency(unpractised, 2600, NOW);
    expect(seeded.latEMA).toBe(2600);
    expect(seeded.reps).toBe(0);
  });

  /**
   * The reconnaissance, in one assertion: a chord the user is slow on in free
   * play starts its first graded rep with a slow prior rather than from nothing,
   * so it takes more evidence to call it automatic.
   */
  it('leaves a prior for the first graded rep to blend with', () => {
    const harvested = nudgeLatency(fresh(), 3000, NOW);
    expect(harvested.latEMA).toBe(3000);
    expect(inSchedule(harvested)).toBe(false);
  });

  it('never puts a harvested item in the queue', () => {
    // `newItemState` makes an item due immediately, so without `inSchedule` a
    // chord overheard once would arrive in the due pool having never been
    // counted against the daily faucet.
    const harvested = nudgeLatency(fresh(), 3000, NOW);
    expect(harvested.dueAt).toBeLessThanOrEqual(NOW);
    expect(harvested.reps).toBe(0);
    expect(inSchedule(harvested)).toBe(false);
    expect(inSchedule({ ...harvested, reps: 1 })).toBe(true);
  });
});
