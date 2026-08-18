/**
 * The beat grid: where a timed drill's beats fall, on both clocks.
 *
 * This is the arithmetic half of the pulse drill. Like `engine.ts` it is
 * deliberately free of Tone.js and Web Audio, because it is the exact place
 * CLAUDE.md's clock gotcha bites: a Transport position is a time on the
 * `AudioContext` clock, every played note is a time on the `performance.now()`
 * clock, and getting the conversion wrong shifts every timing score by a
 * constant that no screen would ever show. That conversion is one line
 * (`clock.ts`), and it is tested here rather than discovered later.
 *
 * Two decisions are recorded in the shape of a plan.
 *
 * **The count-in is part of the plan and not part of the grid.** Beat 0 is the
 * first graded beat, which is the beat after the count-in, so `gridStartMs` is
 * what the grader gets and the count-in clicks sit at negative beat numbers. A
 * drill that graded its own count-in would be measuring the user's reading speed
 * for the word "go".
 *
 * **The whole plan exists before the first click sounds.** Everything is
 * computed from one start time and one tempo, up front. Nothing about the grid
 * is discovered as it plays, so the grader can be handed the grid the moment the
 * prompt is armed, and a dropped frame or a busy tab cannot move a beat.
 */

import { contextTimeToMidiTs } from './clock.ts';

/** How long a beat lasts, from the tempo. The Transport agrees, by construction. */
export const beatSecondsOf = (bpm: number): number => 60 / bpm;

/**
 * Clicks before beat 0, for every timed drill.
 *
 * Here rather than on a drill because it is a property of how a timed prompt is
 * delivered, not of any one pattern. It lived on the pulse drill until a second
 * timed drill arrived and the engine turned out to be reading one drill's
 * constants to lay out another drill's grid.
 */
export const COUNT_IN_BEATS = 4;

export interface PulseOptions {
  /** AudioContext seconds: when the Transport starts, i.e. the first count-in click. */
  startSec: number;
  bpm: number;
  /** Clicks before beat 0. Not graded. */
  countInBeats: number;
  /** Graded beats. */
  beats: number;
  /** performanceTime = contextTime * 1000 + offsetMs (clock.ts). */
  offsetMs: number;
}

export interface PulsePlan {
  bpm: number;
  beatSec: number;
  countInBeats: number;
  beats: number;
  startSec: number;
  /** Every click, count-in first, in AudioContext seconds. */
  clickTimesSec: number[];
  /** Which of those clicks is beat 0. */
  gridStartIndex: number;
  /** Beat 0 on the audio clock, and the same instant on the MIDI clock. */
  gridStartSec: number;
  gridStartMs: number;
  /** The first count-in click, on the MIDI clock. */
  countInStartMs: number;
  /** The last graded beat, on the MIDI clock. */
  lastBeatMs: number;
}

/**
 * Lay out one run. Pure: given a start time, a tempo and the clock offset, the
 * whole grid follows, on both clocks.
 */
export function planPulse(opts: PulseOptions): PulsePlan {
  const beatSec = beatSecondsOf(opts.bpm);
  const total = opts.countInBeats + opts.beats;
  const clickTimesSec = Array.from(
    { length: Math.max(0, total) },
    (_, i) => opts.startSec + i * beatSec
  );
  const gridStartSec = opts.startSec + opts.countInBeats * beatSec;
  const lastBeatSec = gridStartSec + Math.max(0, opts.beats - 1) * beatSec;

  return {
    bpm: opts.bpm,
    beatSec,
    countInBeats: opts.countInBeats,
    beats: opts.beats,
    startSec: opts.startSec,
    clickTimesSec,
    gridStartIndex: opts.countInBeats,
    gridStartSec,
    gridStartMs: contextTimeToMidiTs(gridStartSec, opts.offsetMs),
    countInStartMs: contextTimeToMidiTs(opts.startSec, opts.offsetMs),
    lastBeatMs: contextTimeToMidiTs(lastBeatSec, opts.offsetMs),
  };
}

/**
 * Which beat the run is on at a given moment on the MIDI clock, for the beat
 * readout on screen. Negative during the count-in (-1 is the last click before
 * beat 0), `beats` or more once the run is over.
 *
 * Read from the clock rather than counted by a callback on purpose. A Transport
 * callback would be the obvious source and is the wrong one: with `lookAhead` at
 * 0 (index.ts, so the live echo is not delayed) Tone dispatches its callbacks up
 * to one update interval late, which is fine for sounding a click that was
 * scheduled ahead of time and visibly wrong for a counter that is meant to be
 * the beat.
 */
export function beatIndexAt(plan: PulsePlan, nowMs: number): number {
  return Math.floor((nowMs - plan.gridStartMs) / (plan.beatSec * 1000));
}
