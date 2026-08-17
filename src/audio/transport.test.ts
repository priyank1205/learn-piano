/**
 * Tests for the beat grid.
 *
 * There is not much arithmetic here and it is all trivial, which is exactly why
 * it is tested. CLAUDE.md names this conversion as the app's single most
 * expensive mistake: "Web MIDI timestamps and AudioContext.currentTime have
 * different origins. Compute the offset once at startup and convert. Getting
 * this wrong makes every timing score off by a constant." A constant error has
 * no symptom. Nothing crashes, no number looks absurd, and the user concludes he
 * rushes.
 *
 * So these assert the conversion in both directions and pin the one thing that
 * would be easy to get backwards: the count-in is not part of the grid.
 */

import { describe, expect, it } from 'vitest';
import { beatIndexAt, beatSecondsOf, planPulse } from './transport.ts';
import { contextTimeToMidiTs, midiTsToContextTime } from './clock.ts';

/** A plausible reading: the audio clock started ~9 seconds after the page did. */
const OFFSET_MS = 9_000;

const plan = (over: Partial<Parameters<typeof planPulse>[0]> = {}) =>
  planPulse({
    startSec: 4,
    bpm: 100,
    countInBeats: 4,
    beats: 8,
    offsetMs: OFFSET_MS,
    ...over,
  });

describe('beat length', () => {
  it('is the tempo, and nothing else', () => {
    expect(beatSecondsOf(100)).toBeCloseTo(0.6, 10);
    expect(beatSecondsOf(60)).toBe(1);
  });
});

describe('planPulse', () => {
  it('books every click, count-in included', () => {
    const p = plan();
    expect(p.clickTimesSec).toHaveLength(12);
    expect(p.clickTimesSec[0]).toBe(4);
    expect(p.clickTimesSec[1]).toBeCloseTo(4.6, 10);
  });

  /**
   * Beat 0 is the first GRADED beat. Off by one here and every timing error in
   * the app is one beat out, which at 100 BPM is 600ms and reads as the user
   * having no pulse at all.
   */
  it('starts the grid after the count-in, not at the first click', () => {
    const p = plan();
    expect(p.gridStartSec).toBeCloseTo(4 + 4 * 0.6, 10);
    expect(p.clickTimesSec[p.gridStartIndex]).toBeCloseTo(p.gridStartSec, 10);
  });

  it('converts the grid onto the MIDI clock through the offset', () => {
    const p = plan();
    expect(p.gridStartMs).toBeCloseTo(p.gridStartSec * 1000 + OFFSET_MS, 6);
    // And back again, which is the invariant the whole app leans on.
    expect(midiTsToContextTime(p.gridStartMs, OFFSET_MS)).toBeCloseTo(p.gridStartSec, 9);
  });

  it('puts the last beat one bar-and-a-bit after the first', () => {
    const p = plan();
    expect(p.lastBeatMs - p.gridStartMs).toBeCloseTo(7 * 600, 6);
  });

  it('is exactly the count-in ahead of the grid', () => {
    const p = plan();
    expect(p.gridStartMs - p.countInStartMs).toBeCloseTo(4 * 600, 6);
  });

  /**
   * The failure this file exists for. A grid built with the wrong offset is
   * shifted by the difference and by nothing else, so the error is a bias
   * (see `sequence.test.ts`) rather than noise.
   */
  it('shifts by exactly the offset error when the offset is wrong', () => {
    const right = plan();
    const wrong = plan({ offsetMs: OFFSET_MS + 50 });
    expect(wrong.gridStartMs - right.gridStartMs).toBeCloseTo(50, 6);
  });

  it('survives a run with no count-in', () => {
    const p = plan({ countInBeats: 0 });
    expect(p.gridStartSec).toBe(4);
    expect(p.countInStartMs).toBe(p.gridStartMs);
  });
});

describe('beatIndexAt', () => {
  const p = plan();

  it('is 0 on the first graded beat', () => {
    expect(beatIndexAt(p, p.gridStartMs)).toBe(0);
    expect(beatIndexAt(p, p.gridStartMs + 599)).toBe(0);
    expect(beatIndexAt(p, p.gridStartMs + 601)).toBe(1);
  });

  it('counts backwards through the count-in', () => {
    expect(beatIndexAt(p, p.countInStartMs)).toBe(-4);
    expect(beatIndexAt(p, p.gridStartMs - 1)).toBe(-1);
  });

  it('reads past the end once the run is over', () => {
    expect(beatIndexAt(p, contextTimeToMidiTs(p.gridStartSec + 8 * 0.6, OFFSET_MS))).toBe(
      8
    );
  });
});
