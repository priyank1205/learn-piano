/**
 * The finger legato drill, and the two rules it is the first drill to be
 * constrained by.
 *
 * Its counts are checked against `docs/skill-tree.json` rather than against
 * literals, for the reason `pool.test.ts` gives: the curriculum is the source of
 * truth and a disagreement between it and the code should surface as a failing
 * test rather than as a node that can never read 100%.
 */

import { describe, expect, it } from 'vitest';
import { handOf } from '../midi.ts';
import { legatoOf, nodeById } from '../tree.ts';
import { DEFAULT_TOLERANCES } from '../grade/index.ts';
import { DEFAULT_SETTINGS } from '../store/types.ts';
import { SUSTAIN_SENSITIVE_V1_NODE } from '../audio/engine.ts';
import {
  CONTOUR,
  KEYS,
  LEGATO_ID,
  LEGATO_NODE,
  PENTACHORD,
  legatoLine,
  legatoPitches,
} from './legato.ts';
import type { LegatoParams } from './legato.ts';
import type { DrillItem } from './types.ts';
import { PULSE_BEATS, RHYTHM_TAP_ID, rhythmTap } from './rhythmTap.ts';
import { INVERSION_TRAINER_ID } from './inversionTrainer.ts';
import { itemsFor, itemsForNode } from './registry.ts';
import { gridBeatsOf, isSustainSensitive } from './present.ts';

const threshold = legatoOf(LEGATO_NODE)!;
const itemCount = Number(nodeById(LEGATO_NODE)!.itemCount);

/**
 * The drill's own pool, with its param type restored. The registry erases params
 * so a generic screen can hold any template; a template only ever receives
 * params from its own pool, so the cast back loses nothing that was checked.
 */
const POOL = itemsFor(LEGATO_ID) as readonly DrillItem<LegatoParams>[];

describe('the legato deck', () => {
  it('is the item count the tree declares', () => {
    expect(itemsFor(LEGATO_ID)).toHaveLength(itemCount);
    expect(itemsForNode(LEGATO_NODE)).toHaveLength(itemCount);
  });

  it('is two hands by six keys, because the tree says perHand', () => {
    expect(threshold.perHand).toBe(true);
    expect(KEYS).toHaveLength(itemCount / 2);
    const hands = new Set(POOL.map((i) => i.params.hand));
    expect([...hands].sort()).toEqual(['L', 'R']);
  });

  it('gives every item a label naming the hand, since the hand is the item', () => {
    for (const item of POOL) {
      expect(item.label).toMatch(/left hand|right hand/);
      expect(item.nodeIds).toEqual([LEGATO_NODE]);
    }
  });
});

describe('the pattern', () => {
  it('is nine notes up and back down, so it ends where it started', () => {
    for (const item of POOL) {
      const pitches = legatoPitches(item.params);
      expect(pitches).toHaveLength(CONTOUR.length);
      expect(pitches[0]).toBe(pitches[pitches.length - 1]);
      expect(pitches[4]).toBe(pitches[0]! + 7);
    }
  });

  it('gives eight transitions, which is what makes the 85% share bite', () => {
    // Seven of eight clears 0.85 and six does not. A shorter pattern would make
    // the share coarser than the threshold it is measured against.
    const transitions = CONTOUR.length - 1;
    expect(transitions).toBe(8);
    expect(7 / transitions).toBeGreaterThanOrEqual(threshold.inBandShare);
    expect(6 / transitions).toBeLessThan(threshold.inBandShare);
  });

  it('is a major pentachord, from tonal', () => {
    const c = legatoPitches({ hand: 'R', key: 'C' });
    expect(PENTACHORD).toHaveLength(5);
    // C D E F G, in the right hand's octave.
    expect(c.slice(0, 5)).toEqual([60, 62, 64, 65, 67]);
  });

  it('runs at the tree tempo and subdivision', () => {
    const expected = legatoLine.buildExpected({ hand: 'R', key: 'C' });
    expect(expected.tempoBpm).toBe(threshold.tempoBpm);
    // Two notes a beat: the step between consecutive events is half a beat.
    expect(expected.events[1]!.atBeat! - expected.events[0]!.atBeat!).toBeCloseTo(
      1 / threshold.notesPerBeat,
      6
    );
  });
});

/**
 * architecture.md section 3.1: "Specs whose expected events cross the split are
 * rejected at authoring time - hand-crossing is ungradable on this instrument
 * and no drill may require it."
 *
 * This is the reason the hands sit two octaves apart rather than one, and it is
 * the sort of constraint that is obvious once written down and invisible when it
 * is not: at one octave apart the left hand's G position reaches C4, which is
 * the split point itself, and half of it would be graded as the right hand.
 */
describe('the hand split', () => {
  const splitPoint = legatoLine.constraints.splitPoint!;

  it('puts every note of an item on its own side of the split', () => {
    for (const item of POOL) {
      for (const pitch of legatoPitches(item.params)) {
        expect(handOf(pitch, splitPoint)).toBe(item.params.hand);
      }
    }
  });

  it('would not hold with the hands one octave apart, which is why they are not', () => {
    const crossing = legatoPitches({ hand: 'L', key: 'G' }).map((p) => p + 12);
    expect(crossing.some((p) => handOf(p, splitPoint) === 'R')).toBe(true);
  });

  it('stays inside the 61 keys', () => {
    for (const item of POOL) {
      for (const pitch of legatoPitches(item.params)) {
        expect(pitch).toBeGreaterThanOrEqual(36);
        expect(pitch).toBeLessThanOrEqual(96);
      }
    }
  });
});

describe('what the drill hands the grader', () => {
  it('asks for the legato family and passes the trees share to it', () => {
    expect(legatoLine.grading.graderId).toBe('legato');
    expect(legatoLine.grading.legato?.inBandShare).toBe(threshold.inBandShare);
  });

  /**
   * The band is the exception, and deliberately so: architecture.md section 9.1
   * puts it first on the list of numbers that will be wrong, so it travels as a
   * setting rather than on the drill. The tree still owns where it starts.
   */
  it('does not carry the band, which is a setting starting at the trees value', () => {
    expect(legatoLine.grading.tolerances?.legatoBandMs).toBeUndefined();
    expect(DEFAULT_SETTINGS.legatoBandMs).toEqual(threshold.overlapBandMs);
    expect([...DEFAULT_TOLERANCES.legatoBandMs]).toEqual(threshold.overlapBandMs);
  });
});

describe('routing the one sustain-sensitive V1 node', () => {
  /**
   * architecture.md section 6: "Every `sustainSensitive: true` node MUST route
   * playback through the app piano." The instrument's own sustain is permanently
   * on and transmits nothing, so it hides precisely what this grader measures.
   */
  it('is the node the audio engine names', () => {
    expect(SUSTAIN_SENSITIVE_V1_NODE).toBe(LEGATO_NODE);
    expect(nodeById(LEGATO_NODE)!.sustainSensitive).toBe(true);
    expect(isSustainSensitive([LEGATO_NODE])).toBe(true);
  });

  it('is the only drilled node that needs it', () => {
    for (const item of itemsFor(INVERSION_TRAINER_ID)) {
      expect(isSustainSensitive(item.nodeIds)).toBe(false);
    }
    for (const item of itemsFor(RHYTHM_TAP_ID)) {
      expect(isSustainSensitive(item.nodeIds)).toBe(false);
    }
  });
});

/**
 * The engine used to lay out every timed drill's click track from the pulse
 * drill's own constants, which was correct while there was one timed drill. Nine
 * eighth notes span four beats and eight quarter notes span eight, and neither
 * drill should have to know the other exists.
 */
describe('the click track a timed drill is counted against', () => {
  it('covers the legato pattern and no more', () => {
    // Nine eighth notes: beats 0 to 4, so five clicks.
    expect(gridBeatsOf(legatoLine.buildExpected({ hand: 'R', key: 'C' }))).toBe(5);
  });

  it('still covers the pulse drill exactly, which is where it came from', () => {
    const pulse = itemsFor(RHYTHM_TAP_ID)[0]!;
    const expected = rhythmTap.buildExpected(pulse.params as never);
    expect(gridBeatsOf(expected)).toBe(PULSE_BEATS);
  });

  it('never asks for fewer than one beat', () => {
    expect(gridBeatsOf({ tempoBpm: 72, events: [] })).toBe(1);
  });
});
