/**
 * Watching what is sounding, and deciding when it became a chord.
 *
 * The HUD is not a drill. Nothing here prompts, grades, or schedules: the user
 * plays a chart exactly as he does today and the app watches
 * (session-generator.md section 8). What that needs is different from what a
 * grader needs, and the difference is worth stating, because the temptation is
 * to reuse `clusterNoteOns` and be done.
 *
 * **A grader clusters onsets; a HUD tracks what is down.** A drill prompt has a
 * moment it was asked and a chord that answers it inside 80ms, so onsets that
 * arrive together are one answer. Free playing has neither. A chart chord is
 * held, is often rolled well past any cluster window, may gain a doubled octave
 * halfway through, and is over when the hand leaves it. So this folds note-ons
 * and note-offs into a **sounding set**, and calls it a chord once that set has
 * been stable for the settle window.
 *
 * Two consequences follow, and both are deliberate.
 *
 * **The same chord twice is one chord.** Re-striking what is already sounding is
 * not a chord change, and counting it as one would fill the harvest with
 * observations of a hand that never moved.
 *
 * **Change latency is measured from when the previous chord broke.** section 8
 * defines it as the "gap between successive chart chords vs. the chart's grid",
 * and there is no chart and no grid: the app is watching, not accompanying. What
 * it can see is the moment the previous chord stopped being intact - its first
 * release - and the moment this one was complete. The span between them is the
 * hand in transit, and it is the honest V1 reading of section 8's number.
 *
 * It is a **floor** on the hunting rather than the whole of it, and that is the
 * limitation to remember before trusting a number here: a player who holds the
 * old chord while working out the next one is thinking on the app's blind side.
 * Which is exactly why section 8 calls this low-trust telemetry, gives it an
 * alpha of 0.1, and keeps it out of scheduling.
 */

import type { NormalizedEvent } from '../midi.ts';
import { pitchClassOf } from '../theory.ts';
import type { DrillItem } from '../drills/types.ts';
import { DRILLS, itemsFor } from '../drills/registry.ts';

/** Fewer notes than this is not a chord to name. Triads are the V1 pool. */
export const MIN_CHORD_NOTES = 3;

/**
 * How long a sounding set must hold still before it counts as a chord. The same
 * number the untimed grader settles an answer on, and for the same reason: a
 * hand still arriving is not an answer yet.
 */
export const CHORD_SETTLE_MS = 300;

export interface SoundingChord {
  /** Ascending, deduplicated. What was down when the set settled. */
  pitches: number[];
  /** The lowest sounding note. Which inversion this is. */
  bassPitch: number;
  /** The earliest note-on still held when it settled. */
  startedAt: number;
  /** The latest note-on still held: when the chord was finished. */
  completedAt: number;
  /** The first release that broke it. Null while it is still intact. */
  brokenAt: number | null;
}

export interface ChordChange {
  chord: SoundingChord;
  previous: SoundingChord | null;
  /**
   * `completedAt(this) - brokenAt(previous)`, the hand in transit. Null for the
   * first chord of a run, and null when the previous chord was still intact as
   * this one completed, which is a change with no gap to measure.
   */
  changeLatencyMs: number | null;
  /** The pool item this chord is, if any drill declares it. */
  item: DrillItem | undefined;
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Folds the MIDI stream into chords.
 *
 * Stateful because the question is stateful: what is sounding right now is not a
 * function of any one event. `handle` is fed every event and `poll` is called on
 * animation frames, which is where the settle deadline is checked - the same
 * discipline as everywhere else in this app, because a `setInterval` is banned
 * for anything musical and a background tab would throttle it to one a second.
 */
export class ChordWatcher {
  private readonly down = new Map<number, number>();
  private lastChangeTs = 0;
  private emittedSet: number[] | null = null;
  private current: SoundingChord | null = null;

  /** Sounding pitches, ascending. For the live readout. */
  held(): number[] {
    return [...this.down.keys()].sort((a, b) => a - b);
  }

  /** The chord currently named, or null if what is down has not settled. */
  chord(): SoundingChord | null {
    return this.current;
  }

  handle(event: NormalizedEvent): void {
    if (event.type === 'on') {
      this.down.set(event.pitch, event.ts);
      this.lastChangeTs = event.ts;
      this.emittedSet = null;
      return;
    }
    if (event.type !== 'off') return;
    if (!this.down.delete(event.pitch)) return;
    this.lastChangeTs = event.ts;
    this.emittedSet = null;
    // The first release that touches the named chord is when it stopped being
    // intact, which is where the next chord's change latency is measured from.
    if (
      this.current !== null &&
      this.current.brokenAt === null &&
      this.current.pitches.includes(event.pitch)
    ) {
      this.current.brokenAt = event.ts;
    }
  }

  /**
   * Has what is down settled into a chord? Returns it once, the first time.
   *
   * `nowMs` is the frame clock, which shares an origin with every MIDI
   * timestamp. Nothing measured comes from it: the chord's own times are the
   * note timestamps, so a late frame delays the name appearing on screen and
   * cannot move a number.
   */
  poll(nowMs: number): ChordChange | null {
    if (this.down.size < MIN_CHORD_NOTES) return null;
    if (nowMs - this.lastChangeTs < CHORD_SETTLE_MS) return null;

    const pitches = this.held();
    if (this.emittedSet !== null && sameSet(this.emittedSet, pitches)) return null;
    this.emittedSet = pitches;

    // The same notes sounding again is the same chord, not a change to it. A
    // re-strike is a hand that has not moved, and the harvest must not hear one
    // as evidence about how fast the hand moves.
    const previous = this.current;
    if (previous !== null && sameSet(previous.pitches, pitches)) return null;

    let startedAt = Infinity;
    let completedAt = -Infinity;
    for (const ts of this.down.values()) {
      startedAt = Math.min(startedAt, ts);
      completedAt = Math.max(completedAt, ts);
    }

    const chord: SoundingChord = {
      pitches,
      bassPitch: pitches[0]!,
      startedAt,
      completedAt,
      brokenAt: null,
    };
    this.current = chord;

    const gap = previous?.brokenAt != null ? chord.completedAt - previous.brokenAt : null;

    return {
      chord,
      previous,
      // A non-positive gap means this chord was complete before the last one
      // came apart. Nothing was hunted for, so there is nothing to observe.
      changeLatencyMs: gap !== null && gap > 0 ? gap : null,
      item: attributeChord(pitches),
    };
  }

  reset(): void {
    this.down.clear();
    this.lastChangeTs = 0;
    this.emittedSet = null;
    this.current = null;
  }
}

/**
 * The shape a chord is: its pitch classes, and which one is underneath.
 *
 * Octave-equivalent with the bass named separately, which is exactly what the
 * inversion trainer grades on (`octaveEquivalent` plus `inversionStrict`). So a
 * chart voicing with a doubled root two octaves down is the same shape as the
 * three-note reference, which is the point: the HUD is watching real playing.
 */
export function shapeKey(pitches: readonly number[], bassPc: number): string {
  const pcs = [...new Set(pitches.map(pitchClassOf))].sort((a, b) => a - b);
  return `${pcs.join(',')}/${bassPc}`;
}

/**
 * Every chord shape any registered drill can produce, keyed by shape.
 *
 * Built over the registry rather than off the inversion trainer by name, so this
 * stays "drills are data": what qualifies is a template whose items are one
 * untimed event of three or more pitches with a declared bass, which is the
 * definition of a chord item and which no future chord drill will have to be
 * added here to satisfy. The pulse and note-find pools decline it on their own.
 */
const BY_SHAPE = ((): Map<string, DrillItem> => {
  const index = new Map<string, DrillItem>();
  for (const [templateId, template] of Object.entries(DRILLS)) {
    for (const item of itemsFor(templateId)) {
      const expected = template.buildExpected(item.params);
      if (expected.tempoBpm !== undefined || expected.events.length !== 1) continue;
      const event = expected.events[0]!;
      if (event.bassPc === undefined || event.pitches.length < MIN_CHORD_NOTES) continue;
      index.set(shapeKey(event.pitches, event.bassPc), item);
    }
  }
  return index;
})();

/**
 * Which item is this chord, if any?
 *
 * **Attribution is deterministic and does not use `Chord.detect`.**
 * architecture.md section 2 reserves detection for display, and this is not
 * display: it decides whose `latEMA` moves. So the sounding notes are matched
 * against the shapes `buildExpected` produces, which is the same comparison the
 * grader makes, and `detectChordNames` is left to do the naming on screen.
 */
export function attributeChord(pitches: readonly number[]): DrillItem | undefined {
  if (pitches.length < MIN_CHORD_NOTES) return undefined;
  const bass = Math.min(...pitches);
  return BY_SHAPE.get(shapeKey(pitches, pitchClassOf(bass)));
}

/** How many chord shapes the HUD can attribute. For the screen's own readout. */
export const attributableShapes = (): number => BY_SHAPE.size;
