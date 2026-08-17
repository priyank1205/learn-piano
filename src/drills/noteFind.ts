/**
 * Note find. The root gate of the keyboard-theory track (`kt-geography`), and
 * the first drill a new install can serve.
 *
 * The tree is blunt about what it is for: "Calibration node, likely already
 * near-mastered; expected to clear in one or two sessions and mostly exists to
 * seed latency baselines." Nobody is learning where D is. What this measures is
 * how long finding it takes, which is the number every later drill is built on:
 * `kt-triads-root` sits directly behind this node because "chord latency is
 * meaningless if part of it is spent hunting for the root note".
 *
 * Twelve items, one per key of the octave, answered in any octave.
 *
 * **The spelling is drawn per rep, not per item.** The tree declares twelve
 * items and there are seventeen names for twelve keys, so a param space of names
 * would either be the wrong size or ask "Db" and never "C#". The item is the key
 * under the finger, the spelling is one rep's way of asking for it, and both
 * names are on the label. This is the same decision the inversion trainer makes
 * for its roots, arrived at from the other direction, and it is what
 * `prepare` exists for (`types.ts`).
 *
 * **Any octave counts.** "Find any named note in any octave without hunting":
 * the note is graded octave-equivalently, so C2 and C6 are both right, and the
 * user is never being asked to read an octave number under time pressure.
 */

import { pitchClassName } from '../theory.ts';
import type { DrillTemplate, PromptView, Rng } from './types.ts';
import type { ExpectedPerformance } from '../grade/index.ts';

export type NoteFindParams = {
  /** 0..11. The key, not the name. */
  pc: number;
  /** Per rep: which of the key's two names this prompt uses. Never an item id. */
  sharps?: 0 | 1;
};

export const NOTE_FIND_ID = 'note-find';

const GEOGRAPHY_NODE = 'kt-geography';

const PITCH_CLASSES: readonly number[] = Array.from({ length: 12 }, (_, i) => i);

/**
 * Where the "hear it" reference sounds. Middle of the instrument, and the same
 * octave for every item so the reference cannot be mistaken for the answer:
 * the answer is a pitch class, and any octave of it is right.
 */
export const REFERENCE_OCTAVE_PITCH = 60;

/** Both names of a black key, one of a white one. What the item is called. */
export function keyLabel(pc: number): string {
  const sharp = pitchClassName(pc, { sharps: true });
  const flat = pitchClassName(pc, { sharps: false });
  return sharp === flat ? sharp : `${sharp}/${flat}`;
}

export const noteFind: DrillTemplate<NoteFindParams> = {
  id: NOTE_FIND_ID,
  name: 'Note find',
  nodeIds: [GEOGRAPHY_NODE],
  promptMode: 'text',
  answerMode: 'play',

  paramSpace: { pc: PITCH_CLASSES },

  prepare(params, rng: Rng): NoteFindParams {
    return { pc: params.pc, sharps: rng() < 0.5 ? 1 : 0 };
  },

  /**
   * One untimed event holding one note. The pitch is the reference octave and
   * the grader reduces it to a pitch class, so what this really carries is the
   * key, which is the whole item.
   */
  buildExpected(params): ExpectedPerformance {
    return { events: [{ pitches: [REFERENCE_OCTAVE_PITCH + params.pc] }] };
  },

  grading: { graderId: 'set' },

  constraints: { octaveEquivalent: true },

  nodesFor(): string[] {
    return [GEOGRAPHY_NODE];
  },

  view(params): PromptView {
    const sharps = params.sharps === 1;
    const name = pitchClassName(params.pc, { sharps });
    return {
      primary: name,
      secondary: 'any octave',
      answer: name,
      audition: [REFERENCE_OCTAVE_PITCH + params.pc],
      sharps,
    };
  },

  label(params): string {
    return keyLabel(params.pc);
  },
};
