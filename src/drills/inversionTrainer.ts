/**
 * The inversion trainer. V1 drill 1, and the drill the whole app was designed
 * around: he can work an inversion out in about four seconds and the goal is
 * under 1.2, so what this measures is latency, and correctness only gates it.
 *
 * 72 items: twelve roots, two qualities, three inversions. Prompted by symbol
 * (`Db/F`), answered by playing it in any octave, graded by the `set` grader.
 *
 * Three decisions worth reading before changing anything here.
 *
 * **The root is a pitch class, not a name.** Root names are quality-dependent
 * (a minor triad on Gb spells its third Bbb, which teaches nothing about a
 * keyboard, so minor uses F#), and a param space of names would either produce
 * invalid combinations or need a filter. A pitch class keeps the cartesian
 * product whole and correct, and spelling stays where it belongs, in the
 * prompt. See `rootNameOf`.
 *
 * **Root position is in this drill, not next to it.** The tree gives
 * kt-triads-root its own drillType, `chord-play`, and the v1Patch note settles
 * how to read that: "the inversion-trainer component handles it as inversion
 * index 0. No separate grader." Inversion 0 is the same prompt, the same
 * grader, and the same measurement.
 *
 * **An item can belong to two nodes.** The tree declares 24 items for
 * kt-triads-root and 36 for each inversion node, over 72 distinct triads, so
 * root-position triads count toward both the root node and their inversion
 * node. `nodesFor` implements exactly that, and the pool test checks the three
 * counts against the tree.
 */

import {
  INVERSIONS,
  INVERSION_LABELS,
  chordSymbol,
  pitchClassOf,
  rootNameOf,
  triadNoteNames,
  triadPitches,
} from '../theory.ts';
import type { Inversion, TriadQuality } from '../theory.ts';
import type { DrillTemplate, PromptView } from './types.ts';
import type { ExpectedPerformance } from '../grade/index.ts';

/**
 * A type alias rather than an interface, deliberately: only an alias picks up
 * the implicit index signature that makes it assignable to `DrillParams`, and
 * the drill engine has to be able to hash any template's params generically.
 */
export type InversionParams = {
  /** 0..11. Spelled per quality at prompt time. */
  rootPc: number;
  quality: TriadQuality;
  inversion: Inversion;
};

export const INVERSION_TRAINER_ID = 'inversion-trainer';

const PITCH_CLASSES: readonly number[] = Array.from({ length: 12 }, (_, i) => i);
const QUALITIES: readonly TriadQuality[] = ['maj', 'min'];

/** The inversion node a quality belongs to. */
const INVERSION_NODE: Record<TriadQuality, string> = {
  maj: 'kt-inv-maj-triads',
  min: 'kt-inv-min-triads',
};

const ROOT_NODE = 'kt-triads-root';

export const inversionTrainer: DrillTemplate<InversionParams> = {
  id: INVERSION_TRAINER_ID,
  name: 'Inversion trainer',
  nodeIds: [ROOT_NODE, INVERSION_NODE.maj, INVERSION_NODE.min],
  promptMode: 'chord-symbol',
  answerMode: 'play',

  paramSpace: {
    rootPc: PITCH_CLASSES,
    quality: QUALITIES,
    inversion: INVERSIONS,
  },

  /**
   * One untimed event: the notes of the triad, plus the pitch class that has to
   * be underneath them. Absolute pitches are the reference voicing, and the
   * grader reduces both sides to pitch classes because the drill is
   * octave-equivalent, so what these pitches really carry is the bass.
   */
  buildExpected(params): ExpectedPerformance {
    const pitches = triadPitches(
      rootNameOf(params.rootPc, params.quality),
      params.quality,
      params.inversion
    );
    return { events: [{ pitches, bassPc: pitchClassOf(pitches[0]!) }] };
  },

  grading: { graderId: 'set' },

  constraints: {
    // Any octave is fine. Which note is on the bottom is the whole exercise.
    octaveEquivalent: true,
    inversionStrict: true,
  },

  nodesFor(params): string[] {
    const inversionNode = INVERSION_NODE[params.quality];
    return params.inversion === 0 ? [ROOT_NODE, inversionNode] : [inversionNode];
  },

  view(params): PromptView {
    const root = rootNameOf(params.rootPc, params.quality);
    const names = triadNoteNames(root, params.quality, params.inversion);
    const symbol = chordSymbol(root, params.quality, params.inversion);
    return {
      primary: symbol,
      secondary: INVERSION_LABELS[params.inversion],
      answer: names.join(' '),
      audition: triadPitches(root, params.quality, params.inversion),
      // Flat spellings beside a flat symbol. "C#" next to "Db/F" reads as a
      // different note.
      sharps: !symbol.includes('b'),
    };
  },

  label(params): string {
    return chordSymbol(
      rootNameOf(params.rootPc, params.quality),
      params.quality,
      params.inversion
    );
  },
};
