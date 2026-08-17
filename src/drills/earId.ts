/**
 * Interval identification by ear. `ear-intervals-1`, the root of the ear track,
 * which the tree says "starts week one" and which has no dependencies at all.
 *
 * Two notes are played, ascending. The user plays the second one back. Six
 * items: M2, m3, M3, P4, P5, P8.
 *
 * **The starting note is drawn per rep.** The tree declares six items and the
 * interval is what is being learned, so the key it is heard in cannot be part of
 * the item without turning six into seventy-two. It also must not be constant:
 * architecture.md section 9.5 asks whether ear accuracy correlates with key
 * familiarity ("worse in Db than in C"), and a drill that always started on C
 * could never answer that. See `prepare` in `types.ts` for the rule this follows.
 *
 * **The answer is an exact pitch, not a pitch class.** Every other drill in V1
 * is octave-equivalent; this one cannot be. An octave-equivalent P8 would be
 * satisfied by playing the note the user has just been given, which grades a
 * memory of a sound as a hearing of an interval. Naming the octave is part of
 * hearing where the second note went.
 *
 * **`answerMode` is `play`, and this is the decision to revisit first.** The
 * tree's node says "Answer by playing the second note from a given first note",
 * and architecture.md section 9.5 says to switch the deck to `answerMode:
 * 'choice'` **if** accuracy turns out to correlate with key familiarity, because
 * that would mean keyboard fluency is contaminating the ear signal. That is a
 * response to a measurement, and the measurement does not exist yet: this drill
 * is what produces it. Answering on the keyboard also doubles as keyboard
 * training, which section 9.5 credits before it warns. The trigger for flipping
 * is written down in the README, and the flip is a change to this file plus a
 * non-MIDI answer path in the runner.
 *
 * **Latency starts when the sound stops.** architecture.md section 5:
 * `promptReadyAt` is "end of audio playback for ear prompts. Latency never
 * includes listening time." The runner's `Presenter` is how that is delivered,
 * and `drills/present.ts` is what supplies it.
 */

import { intervalName, intervalSemitones, noteNameOf } from '../theory.ts';
import type { DrillTemplate, PromptView, Rng } from './types.ts';
import type { ExpectedPerformance } from '../grade/index.ts';

export type EarIntervalParams = {
  /** A tonal interval name: 'M2', 'm3', 'P5'. */
  interval: string;
  /** Per rep: the note the interval is heard from. Never part of an item id. */
  rootPitch?: number;
};

export const EAR_ID = 'ear-id';

const EAR_NODE = 'ear-intervals-1';

/** The tree's own list, in its own order: "M2, m3, M3, P4, P5, P8 melodic ascending". */
export const CORE_INTERVALS: readonly string[] = ['M2', 'm3', 'M3', 'P4', 'P5', 'P8'];

/**
 * Where the first note may fall: C3 to E4. Low enough to be clearly pitched,
 * high enough that an octave above the top of the range (E5) is still well
 * inside the instrument's 61 keys, so no item is ever unanswerable.
 */
export const ROOT_RANGE: readonly [number, number] = [48, 64];

export const DEFAULT_ROOT_PITCH = 60;

export function drawRootPitch(rng: Rng): number {
  const [lo, hi] = ROOT_RANGE;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

const rootOf = (params: EarIntervalParams): number =>
  params.rootPitch ?? DEFAULT_ROOT_PITCH;

/** The two pitches of one rep, low first. */
export function earPitches(params: EarIntervalParams): number[] {
  const root = rootOf(params);
  return [root, root + intervalSemitones(params.interval)];
}

export const earId: DrillTemplate<EarIntervalParams> = {
  id: EAR_ID,
  name: 'Interval ear training',
  nodeIds: [EAR_NODE],
  promptMode: 'audio',
  answerMode: 'play',

  paramSpace: { interval: CORE_INTERVALS },

  prepare(params, rng): EarIntervalParams {
    return { interval: params.interval, rootPitch: drawRootPitch(rng) };
  },

  /**
   * One untimed event holding the second note. The first note is the prompt, not
   * the answer, so it is in the view and not here.
   */
  buildExpected(params): ExpectedPerformance {
    const [, second] = earPitches(params);
    return { events: [{ pitches: [second!] }] };
  },

  grading: { graderId: 'set' },

  // Not octave-equivalent. See the header: an octave-equivalent P8 grades itself.
  constraints: {},

  nodesFor(): string[] {
    return [EAR_NODE];
  },

  view(params): PromptView {
    const [first, second] = earPitches(params);
    return {
      // Nothing to read. The prompt is the sound, and a symbol on screen while
      // it plays is something to look at instead of listening.
      primary: 'listen',
      secondary: `from ${noteNameOf(first!)}`,
      answer: `${intervalName(params.interval)} (${params.interval}): ${noteNameOf(second!)}`,
      audition: [first!, second!],
      sharps: true,
    };
  },

  label(params): string {
    return `${params.interval} up`;
  },
};
