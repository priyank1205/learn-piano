/**
 * Tests for chord clustering and settle detection.
 *
 * These two functions decide what counts as one answer. Every latency number
 * the scheduler ever sees is `completeTs - promptReadyAt` of a cluster produced
 * here, so a clustering bug does not look like a bug: it looks like the user
 * being slow, and it would be tuned around for weeks.
 */

import { describe, expect, it } from 'vitest';
import {
  applyTranspose,
  clusterNoteOns,
  firstSettledCluster,
  matchSpace,
} from './preprocess.ts';
import { DEFAULT_TOLERANCES } from './types.ts';
import type { NormalizedEvent } from '../midi.ts';

const { chordClusterMs, settleMs } = DEFAULT_TOLERANCES;

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

describe('clusterNoteOns', () => {
  it('groups simultaneous note-ons into one chord', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1005), on(67, 1012)],
      chordClusterMs
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.pitches).toEqual([60, 64, 67]);
    expect(clusters[0]!.spreadMs).toBe(12);
  });

  it('ignores note-offs', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), off(60, 1100), on(64, 1010)],
      chordClusterMs
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.pitches).toEqual([60, 64]);
  });

  /**
   * The distinction the whole grader rests on. A chord is "placed" at the
   * median onset, which a single rolled note cannot drag; it is "finished" at
   * the last onset, which is when the user has actually answered.
   */
  it('separates when a chord was placed from when it was finished', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1010), on(67, 1060)],
      chordClusterMs
    );
    expect(clusters[0]!.onsetTs).toBe(1010);
    expect(clusters[0]!.completeTs).toBe(1060);
    expect(clusters[0]!.startTs).toBe(1000);
  });

  it('starts a new cluster past the cluster window', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1000 + chordClusterMs + 1)],
      chordClusterMs
    );
    expect(clusters.map((c) => c.pitches)).toEqual([[60], [64]]);
  });

  it('includes a note exactly on the window edge', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1000 + chordClusterMs)],
      chordClusterMs
    );
    expect(clusters).toHaveLength(1);
  });

  /**
   * A repeated pitch is a second strike, not a wider chord. Without this a
   * trill inside the window would collapse into one cluster and grade as a
   * single note.
   */
  it('starts a new cluster on a repeated pitch inside the window', () => {
    const clusters = clusterNoteOns([on(60, 1000), on(60, 1020)], chordClusterMs);
    expect(clusters.map((c) => c.pitches)).toEqual([[60], [60]]);
  });

  it('measures the window from the cluster start, not the previous note', () => {
    // 40ms apart each, but the third is 80ms past the start: still one chord,
    // and a fourth at 90ms is not.
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1040), on(67, 1080), on(71, 1090)],
      chordClusterMs
    );
    expect(clusters.map((c) => c.pitches)).toEqual([[60, 64, 67], [71]]);
  });

  it('sorts an out-of-order buffer before clustering', () => {
    const clusters = clusterNoteOns(
      [on(67, 1012), on(60, 1000), on(64, 1005)],
      chordClusterMs
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.startTs).toBe(1000);
    expect(clusters[0]!.order).toEqual([60, 64, 67]);
  });

  it('records the striking order so a roll stays visible', () => {
    const clusters = clusterNoteOns(
      [on(67, 1000), on(60, 1020), on(64, 1040)],
      chordClusterMs
    );
    expect(clusters[0]!.order).toEqual([67, 60, 64]);
    expect(clusters[0]!.pitches).toEqual([60, 64, 67]);
  });

  it('returns nothing for an empty stream', () => {
    expect(clusterNoteOns([], chordClusterMs)).toEqual([]);
  });
});

describe('firstSettledCluster', () => {
  it('is null while the settle window is still open', () => {
    const clusters = clusterNoteOns([on(60, 1000)], chordClusterMs);
    expect(firstSettledCluster(clusters, settleMs, 1000 + settleMs - 1)).toBeNull();
  });

  it('settles once the window has passed', () => {
    const clusters = clusterNoteOns([on(60, 1000)], chordClusterMs);
    const settled = firstSettledCluster(clusters, settleMs, 1000 + settleMs);
    expect(settled?.cluster.pitches).toEqual([60]);
  });

  it('treats a rep with no clock as finished', () => {
    // The two-argument form architecture.md section 5 documents: re-grading a
    // stored rep must not need to know what time it is now.
    const clusters = clusterNoteOns([on(60, 1000), on(64, 1005)], chordClusterMs);
    expect(firstSettledCluster(clusters, settleMs)?.cluster.pitches).toEqual([60, 64]);
  });

  it('does not settle a cluster that was followed by more playing', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1200), on(67, 1400)],
      chordClusterMs
    );
    // Three separate clusters, each within the settle window of the next, so
    // only the last one can be the answer.
    expect(clusters).toHaveLength(3);
    expect(firstSettledCluster(clusters, settleMs)?.cluster.pitches).toEqual([67]);
  });

  /**
   * The behaviour to know about before it is met at the keyboard: a wrong
   * chord, a pause, then the right one grades the wrong one. The pause was the
   * answer being submitted.
   */
  it('grades the first answer, not the best one', () => {
    const clusters = clusterNoteOns(
      [on(60, 1000), on(64, 1005), on(65, 2000), on(69, 2005)],
      chordClusterMs
    );
    expect(firstSettledCluster(clusters, settleMs)?.cluster.pitches).toEqual([60, 64]);
  });
});

describe('applyTranspose', () => {
  it('shifts expected pitches and leaves zero alone', () => {
    expect(applyTranspose([60, 64, 67], 12)).toEqual([72, 76, 79]);
    expect(applyTranspose([60], 0)).toEqual([60]);
  });
});

describe('matchSpace', () => {
  it('folds to pitch classes when the drill is octave-equivalent', () => {
    expect(matchSpace([72, 76, 79], true)).toEqual([0, 4, 7]);
  });

  it('deduplicates doubled notes', () => {
    expect(matchSpace([60, 72, 64], true)).toEqual([0, 4]);
  });

  it('keeps absolute pitches otherwise', () => {
    expect(matchSpace([67, 60, 64], false)).toEqual([60, 64, 67]);
  });
});
