/**
 * Tests for the three seeding drills: note-find, rhythm-tap and ear-id.
 *
 * Two things are being pinned, and neither is really about these drills.
 *
 * **The item counts come from `docs/skill-tree.json`.** 12, 4 and 6. The tree is
 * the curriculum and these templates are one reading of it, so the counts are
 * asserted against the document rather than against literals: a disagreement is
 * a conversation about which of the two is wrong, and a test that cannot say
 * which is exactly the right shape for that.
 *
 * **The ids are pinned as strings.** An item id is the primary key of practice
 * history and nothing in the app notices when one changes. The deck still works,
 * the grader still grades, and every rep ever logged against the old id is
 * simply never found again. A failure here needs a migration, not a new
 * expectation.
 *
 * The third thing is specific to slice 6 and is the reason `prepare` exists: a
 * param drawn per rep must never reach the id. If it did, "M3 ascending" would
 * become seventeen items the first week and the deck would never come due.
 */

import { describe, expect, it } from 'vitest';
import tree from '../../docs/skill-tree.json';
import { Interval } from 'tonal';
import { itemIdOf } from './hash.ts';
import { itemsFor, itemsForNode } from './registry.ts';
import { instantiate } from './types.ts';
import type { DrillItem } from './types.ts';
import { NOTE_FIND_ID, noteFind, REFERENCE_OCTAVE_PITCH } from './noteFind.ts';
import type { NoteFindParams } from './noteFind.ts';
import { HAND_PITCH, PULSE_BEATS, RHYTHM_TAP_ID, rhythmTap } from './rhythmTap.ts';
import type { RhythmTapParams } from './rhythmTap.ts';
import { CORE_INTERVALS, EAR_ID, ROOT_RANGE, earId, earPitches } from './earId.ts';
import type { EarIntervalParams } from './earId.ts';
import { prepareItem } from './present.ts';
import { timedRunOf } from '../tree.ts';
import { pitchClassOf } from '../theory.ts';

const itemCountOf = (id: string): number => {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No node ${id} in the tree`);
  return node.itemCount as number;
};

/** A generator with a fixed sequence, so a drawn param is an assertion. */
const rolls = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('note-find', () => {
  const items = itemsFor(NOTE_FIND_ID) as readonly DrillItem<NoteFindParams>[];

  it('is one item per key, as the tree declares', () => {
    expect(items).toHaveLength(12);
    expect(itemsForNode('kt-geography')).toHaveLength(itemCountOf('kt-geography'));
  });

  it('assigns the ids that history is keyed on', () => {
    expect(itemIdOf(NOTE_FIND_ID, { pc: 0 })).toBe('0xcpuv50yiysbr');
    expect(itemIdOf(NOTE_FIND_ID, { pc: 11 })).toBe('11m7oct1eivqpr');
  });

  /**
   * The spelling is drawn per rep, so it must not be part of the id. If it were,
   * asking for Db and asking for C# would be two items over one key and the
   * twelve-item deck the tree declares would quietly become seventeen.
   */
  it('keeps the drawn spelling out of the item id', () => {
    const item = items[1]!;
    const sharp = prepareItem(item, () => 0.9);
    const flat = prepareItem(item, () => 0.1);
    expect(sharp.itemId).toBe(item.itemId);
    expect(flat.itemId).toBe(item.itemId);
    expect(sharp.params.sharps).not.toBe(flat.params.sharps);
  });

  it('asks for a black key by both its names, over enough reps', () => {
    const item = items.find((i) => i.params.pc === 1)!;
    const asked = new Set(
      [0.1, 0.9].map(
        (roll) => noteFind.view(prepareItem(item, () => roll).params).primary
      )
    );
    expect(asked).toEqual(new Set(['C#', 'Db']));
    // And the item itself is named for the key, not for one of its spellings.
    expect(item.label).toBe('C#/Db');
  });

  it('expects the named key and accepts it in any octave', () => {
    for (const item of items) {
      const event = noteFind.buildExpected(item.params).events[0]!;
      expect(event.pitches).toHaveLength(1);
      expect(pitchClassOf(event.pitches[0]!)).toBe(item.params.pc);
      expect(event.atBeat).toBeUndefined();
    }
    expect(noteFind.constraints.octaveEquivalent).toBe(true);
    expect(instantiate(noteFind, items[0]!).grading.graderId).toBe('set');
  });

  it('sounds a reference inside the instrument', () => {
    for (const item of items) {
      const [pitch] = noteFind.view(item.params).audition;
      expect(pitch).toBeGreaterThanOrEqual(REFERENCE_OCTAVE_PITCH);
      expect(pitch).toBeLessThan(REFERENCE_OCTAVE_PITCH + 12);
    }
  });
});

describe('rhythm-tap', () => {
  const items = itemsFor(RHYTHM_TAP_ID) as readonly DrillItem<RhythmTapParams>[];
  const threshold = timedRunOf('pr-pulse-sync')!;

  it('is two hands by two tempo tiers, as the tree declares', () => {
    expect(items).toHaveLength(itemCountOf('pr-pulse-sync'));
    expect(new Set(items.map((i) => i.params.hand))).toEqual(new Set(['L', 'R']));
    // The threshold's own target is one of the tiers, or the node could never
    // be completed by drilling it.
    expect(items.some((i) => i.params.tempoBpm === threshold.tempoBpm)).toBe(true);
  });

  it('assigns the ids that history is keyed on', () => {
    expect(itemIdOf(RHYTHM_TAP_ID, { hand: 'R', tempoBpm: 100 })).toBe('1ud8wd106djvqj');
    expect(itemIdOf(RHYTHM_TAP_ID, { hand: 'L', tempoBpm: 80 })).toBe('1btixpg0sd3ivm');
  });

  /** `perHand: true` is why the hand is an item: the bar has to be met with each. */
  it('puts each hand on its own side of the split point', () => {
    expect(HAND_PITCH.L).toBeLessThan(rhythmTap.constraints.splitPoint!);
    expect(HAND_PITCH.R).toBeGreaterThanOrEqual(rhythmTap.constraints.splitPoint!);
    expect(threshold.perHand).toBe(true);
  });

  it('expects quarter notes on one key at the item tempo', () => {
    for (const item of items) {
      const expected = rhythmTap.buildExpected(item.params);
      expect(expected.tempoBpm).toBe(item.params.tempoBpm);
      expect(expected.events).toHaveLength(PULSE_BEATS);
      expect(expected.events.map((e) => e.atBeat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      for (const event of expected.events) {
        expect(event.pitches).toEqual([HAND_PITCH[item.params.hand]]);
        expect(event.hand).toBe(item.params.hand);
      }
    }
  });

  /** A timed drill has to reach the timed grader, or it is graded as a chord. */
  it('grades through the sequence grader, against the tree numbers', () => {
    const prompt = instantiate(rhythmTap, items[0]!);
    expect(prompt.grading.graderId).toBe('sequence');
    expect(prompt.grading.pass).toEqual({
      noteAccuracy: threshold.noteAccuracy,
      meanAbsErrMsMax: threshold.meanAbsErrMsMax,
      timingSdMsMax: threshold.timingSdMsMax,
    });
  });
});

describe('ear-id', () => {
  const items = itemsFor(EAR_ID) as readonly DrillItem<EarIntervalParams>[];

  it('is one item per interval, as the tree declares', () => {
    expect(items).toHaveLength(itemCountOf('ear-intervals-1'));
    expect(items.map((i) => i.params.interval)).toEqual([...CORE_INTERVALS]);
  });

  it('assigns the ids that history is keyed on', () => {
    expect(itemIdOf(EAR_ID, { interval: 'M3' })).toBe('0rdwdyz0tvq02h');
    expect(itemIdOf(EAR_ID, { interval: 'P8' })).toBe('1mr6ok30q4hmed');
  });

  /**
   * The starting note is what makes architecture.md section 9.5 answerable
   * ("worse in Db than in C"), so it has to vary, and the tree declares six
   * items, so it cannot be part of one.
   */
  it('draws the starting note per rep and keeps it out of the id', () => {
    const item = items[2]!;
    const low = prepareItem(item, rolls([0]));
    const high = prepareItem(item, rolls([0.99]));
    expect(low.itemId).toBe(item.itemId);
    expect(high.itemId).toBe(item.itemId);
    expect(low.params.rootPitch).toBe(ROOT_RANGE[0]);
    expect(high.params.rootPitch).toBe(ROOT_RANGE[1]);
  });

  it('plays the interval ascending from the drawn note, via tonal', () => {
    for (const item of items) {
      const params = { ...item.params, rootPitch: 60 };
      const [first, second] = earPitches(params);
      expect(first).toBe(60);
      expect(second! - first!).toBe(Interval.semitones(item.params.interval));
      expect(earId.view(params).audition).toEqual([first, second]);
    }
  });

  /**
   * Not octave-equivalent, and P8 is why: the same pitch class as the note the
   * user was just given would make the answer the prompt.
   */
  it('expects the second note itself, not its pitch class', () => {
    expect(earId.constraints.octaveEquivalent).toBeUndefined();
    const octave = items.find((i) => i.params.interval === 'P8')!;
    const params = { ...octave.params, rootPitch: 60 };
    expect(earId.buildExpected(params).events[0]!.pitches).toEqual([72]);
  });

  it('never asks for a note outside the 61 keys', () => {
    for (const item of items) {
      for (const root of [ROOT_RANGE[0], ROOT_RANGE[1]]) {
        for (const pitch of earPitches({ ...item.params, rootPitch: root })) {
          expect(pitch).toBeGreaterThanOrEqual(36);
          expect(pitch).toBeLessThanOrEqual(96);
        }
      }
    }
  });

  /** An audio prompt, so the runner starts the clock at the end of playback. */
  it('declares itself an audio prompt answered on the keyboard', () => {
    expect(earId.promptMode).toBe('audio');
    expect(earId.answerMode).toBe('play');
  });
});
