/**
 * Rhythm tap. `pr-pulse-sync`, the root gate of the physical-rhythm track and
 * the first drill in this app that is graded against a clock rather than against
 * a chord.
 *
 * The tree: "Quarter notes on one key locked to the Transport click, 60-120 BPM.
 * Baseline for every timing window in the app." That last sentence is the point.
 * architecture.md section 9.2 says the timing windows are among the numbers most
 * likely to be wrong and that the way to fix them is to look at the distribution
 * of |timing error| on passes the user calls good. This drill is where that
 * distribution comes from, which is why it is worth building before anything
 * that depends on rhythm.
 *
 * Four decisions.
 *
 * **Four items is two hands by two tempo tiers.** The tree declares
 * `itemCount: 4` and `perHand: true`, so hands are items rather than a mode: the
 * threshold has to be met with each hand separately, and a random hand per rep
 * could never guarantee that. That leaves two tempo tiers, one of which must be
 * the threshold's own target of 100, and the other is the tier below, because a
 * drill whose easiest form is already the target has no rung to stand on. The
 * 60-120 range in the node's description is the room the difficulty governor has
 * to move in later (session-generator.md section 9 raises timedRun targets by 8%
 * for at-threshold items), and tempo is explicitly "a modifier, not a node"
 * there (section 5.1).
 *
 * **One named key per hand.** Grading compares against expected pitches, so the
 * key cannot be "whichever one you like". C3 for the left hand and C4 for the
 * right sit either side of the default split point (60) and inside the 61-key
 * window, and the prompt says which. Naming it also stops the drill from
 * quietly becoming a two-note exercise when a finger slips.
 *
 * **Eight beats after the count-in.** Eight is enough for a standard deviation
 * to mean anything and short enough that a rep is about as long as a flashcard
 * rep at this tempo, which is what keeps the session budget honest. The count-in
 * is not graded and is not this drill's to declare: `audio/transport.ts` owns
 * `COUNT_IN_BEATS` and puts beat 0 after it.
 *
 * **The pass numbers come from the tree.** `meanAbsErrMsMax` and `timingSdMsMax`
 * are the node's, read through `timedRunOf`, not restated here. When they move,
 * and section 9 says they will, they move in `skill-tree.json`.
 */

import { noteNameOf } from '../theory.ts';
import { timedRunOf } from '../tree.ts';
import type { DrillTemplate, PromptView } from './types.ts';
import type { ExpectedPerformance } from '../grade/index.ts';

export type RhythmTapParams = {
  hand: 'L' | 'R';
  tempoBpm: number;
};

export const RHYTHM_TAP_ID = 'rhythm-tap';

const PULSE_NODE = 'pr-pulse-sync';

/** Beats that are graded. The count-in is the app's, in `audio/transport.ts`. */
export const PULSE_BEATS = 8;

/** One key per hand, either side of the default split point (60 = C4). */
export const HAND_PITCH: Record<RhythmTapParams['hand'], number> = { L: 48, R: 60 };

const HAND_NAME: Record<RhythmTapParams['hand'], string> = {
  L: 'left hand',
  R: 'right hand',
};

/** The threshold's target, and the tier below it. See the header. */
const TARGET_BPM = timedRunOf(PULSE_NODE)?.tempoBpm ?? 100;
const TEMPI: readonly number[] = [Math.round(TARGET_BPM * 0.8), TARGET_BPM];

const HANDS: readonly RhythmTapParams['hand'][] = ['L', 'R'];

export const rhythmTap: DrillTemplate<RhythmTapParams> = {
  id: RHYTHM_TAP_ID,
  name: 'Pulse sync',
  nodeIds: [PULSE_NODE],
  promptMode: 'text',
  answerMode: 'play',

  paramSpace: { hand: HANDS, tempoBpm: TEMPI },

  /**
   * Eight quarter notes on one key. `tempoBpm` on the performance is what makes
   * this a timed drill at all (architecture.md section 2), and `atBeat` counting
   * in whole beats is what tells the grader the subdivision is one note a beat.
   */
  buildExpected(params): ExpectedPerformance {
    const pitch = HAND_PITCH[params.hand];
    return {
      tempoBpm: params.tempoBpm,
      events: Array.from({ length: PULSE_BEATS }, (_, beat) => ({
        pitches: [pitch],
        atBeat: beat,
        hand: params.hand,
      })),
    };
  },

  grading: {
    graderId: 'sequence',
    // The per-rep half of architecture.md section 7's timedRun row. `cleanPasses`
    // and `perHand` are about the node and stay in `schedule/mastery.ts`.
    pass: (() => {
      const t = timedRunOf(PULSE_NODE);
      return {
        noteAccuracy: t?.noteAccuracy ?? 1,
        meanAbsErrMsMax: t?.meanAbsErrMsMax,
        timingSdMsMax: t?.timingSdMsMax,
      };
    })(),
  },

  constraints: {
    // The expected pitch is exact: this is one named key, not a pitch class, and
    // the hand split depends on which octave it is in.
    splitPoint: 60,
  },

  nodesFor(): string[] {
    return [PULSE_NODE];
  },

  view(params): PromptView {
    const pitch = HAND_PITCH[params.hand];
    const name = noteNameOf(pitch);
    return {
      primary: name,
      secondary: `${HAND_NAME[params.hand]} - quarter notes at ${params.tempoBpm} BPM`,
      answer: `${PULSE_BEATS} quarter notes on ${name}`,
      audition: [pitch],
      sharps: true,
    };
  },

  label(params): string {
    return `${noteNameOf(HAND_PITCH[params.hand])} ${HAND_NAME[params.hand]}, ${params.tempoBpm} BPM`;
  },
};
