/**
 * Finger legato. `pr-legato-5finger`, the third and last of the V1 drills, and
 * the only one that measures a note-off.
 *
 * The tree: "Stepwise five-finger patterns, each hand. Trains the release timing
 * sustain has been hiding: note N's note-off must land 10-60ms AFTER note N+1's
 * note-on." That second sentence is why this drill exists at all. The instrument
 * has sustain permanently on and transmits no CC64 (CLAUDE.md), so every legato
 * failure sounds perfect on the keyboard's own speakers. The MIDI stream is not
 * fooled and neither is the grader, and the node is the one V1 node marked
 * `sustainSensitive`, which architecture.md section 6 turns into a requirement:
 * playback MUST route through the app's dry piano so the user's ears can audit
 * what the grader measures. `drills/present.ts` is what enforces that.
 *
 * Four decisions.
 *
 * **Twelve items is two hands by six keys.** The tree declares `itemCount: 12`
 * and `perHand: true`, so hands are items rather than a mode, exactly as in the
 * pulse drill: the threshold has to be met with each hand separately. That
 * leaves six keys, and the six are the major five-finger positions with a
 * white-key thumb (C, D, E, F, G, A), which is the standard set and gets black
 * keys under fingers 2, 3 and 4 without ever asking for a black-key thumb.
 *
 * **The hands sit two octaves apart, not one.** Hands are indistinguishable at
 * the protocol level and are split by pitch alone (CLAUDE.md), and
 * architecture.md section 3.1 rejects at authoring time any spec whose events
 * cross the split. One octave apart fails that test: a left hand at G3 reaches
 * C4 and D4, which are at and above the default split point of 60, so half the
 * left-hand pattern would be graded as the right hand. Left hand in octave 2 and
 * right hand in octave 4 puts every left-hand note at 52 or below and every
 * right-hand note at 60 or above, with room to spare at both ends of the 61 keys.
 *
 * **Nine notes: up and back down.** 1-2-3-4-5-4-3-2-1 ends where it started,
 * which is what makes the last note a note rather than a stop, and gives eight
 * transitions per rep. At the threshold's 72 BPM in eighths that is four beats
 * of playing after a four-beat count-in, so a rep is about as long as a pulse
 * rep and the session budget stays honest. Eight transitions is also what makes
 * the 85% share mean something: seven of eight passes, six does not.
 *
 * **The stage ladder in the node's notes is not built, and could not be.** The
 * tree describes three stages (60 BPM quarters at band [0, 80], then 72 BPM
 * quarters at [10, 60], then 72 BPM eighths at [10, 60] for mastery). Encoding
 * stages as params would make 36 items where the tree declares 12, and the
 * declared count is the denominator mastery is measured against, so the node
 * could never read 100%. What the stages are really varying is the band and the
 * tempo, and the band is a **setting** (architecture.md section 9.1 insists on
 * it: "If stage 1 feels impossible or trivial, recalibrate from his own
 * distribution"). So the ladder is climbed by widening the band and walking it
 * back, on the trainer's own calibration panel, rather than by multiplying items.
 */

import { intervalSemitones, noteNameOf, pitchClassOfName } from '../theory.ts';
import { legatoOf } from '../tree.ts';
import type { DrillTemplate, PromptView } from './types.ts';
import type { ExpectedPerformance } from '../grade/index.ts';

export type LegatoParams = {
  hand: 'L' | 'R';
  /** The key of the five-finger position, by name. Its own major pentachord. */
  key: string;
};

export const LEGATO_ID = 'legato-line';

export const LEGATO_NODE = 'pr-legato-5finger';

/**
 * The major pentachord, from tonal. Hand-rolling `[0, 2, 4, 5, 7]` would be
 * hand-rolled interval maths, which CLAUDE.md forbids for exactly the reason
 * that it is right until the day someone adds a minor position.
 */
export const PENTACHORD: readonly string[] = ['P1', 'M2', 'M3', 'P4', 'P5'];

/** Up and back down. Indices into the pentachord. Nine notes, eight transitions. */
export const CONTOUR: readonly number[] = [0, 1, 2, 3, 4, 3, 2, 1, 0];

/**
 * The six positions, and where each hand puts its thumb. See the header: two
 * octaves apart so the pitch split can tell them apart, both well inside the
 * 61-key window (36 to 96).
 */
export const KEYS: readonly string[] = ['C', 'D', 'E', 'F', 'G', 'A'];

/** MIDI numbers of C in each hand's octave. C2 for the left, C4 for the right. */
export const HAND_OCTAVE_BASE: Record<LegatoParams['hand'], number> = { L: 36, R: 60 };

const HAND_NAME: Record<LegatoParams['hand'], string> = {
  L: 'left hand',
  R: 'right hand',
};

/** The tree's own numbers. When they move, they move in `skill-tree.json`. */
const THRESHOLD = legatoOf(LEGATO_NODE);
const TEMPO_BPM = THRESHOLD?.tempoBpm ?? 72;
const NOTES_PER_BEAT = THRESHOLD?.notesPerBeat ?? 2;

/** Where the thumb of a five-finger position lands, for this hand and key. */
export function rootPitchOf(params: LegatoParams): number {
  const base = HAND_OCTAVE_BASE[params.hand];
  const chroma = pitchClassOfName(params.key);
  if (Number.isNaN(chroma)) throw new RangeError(`Unknown key: ${params.key}`);
  return base + chroma;
}

/** The nine pitches of one rep, in playing order. */
export function legatoPitches(params: LegatoParams): number[] {
  const root = rootPitchOf(params);
  const degrees = PENTACHORD.map((i) => root + intervalSemitones(i));
  return CONTOUR.map((step) => degrees[step]!);
}

/**
 * Spelling. Only F's pentachord has a flat in it (Bb), and every other position
 * here is spelled with sharps or with naturals alone, so one flag covers it.
 * `theory.test.ts` makes the same point about triads: MIDI transmits numbers,
 * and spelling is an app choice rather than an observation.
 */
const sharpsFor = (key: string): boolean => key !== 'F';

export const legatoLine: DrillTemplate<LegatoParams> = {
  id: LEGATO_ID,
  name: 'Finger legato',
  nodeIds: [LEGATO_NODE],
  promptMode: 'text',
  answerMode: 'play',

  paramSpace: { hand: ['L', 'R'], key: KEYS },

  /**
   * Nine notes on the grid. `tempoBpm` is what makes this timed at all
   * (architecture.md section 2) and the half-beat step in `atBeat` is what tells
   * the grader the subdivision is two notes a beat, which is where its matching
   * window comes from.
   */
  buildExpected(params): ExpectedPerformance {
    const pitches = legatoPitches(params);
    return {
      tempoBpm: TEMPO_BPM,
      events: pitches.map((pitch, i) => ({
        pitches: [pitch],
        atBeat: i / NOTES_PER_BEAT,
        hand: params.hand,
      })),
    };
  },

  grading: {
    graderId: 'legato',
    // The per-rep halves of architecture.md section 7's legato row. `cleanPasses`
    // and `perHand` are about the node and stay in `schedule/mastery.ts`; the
    // band is global and lives in the tolerances, where a setting can move it.
    pass: { noteAccuracy: 1 },
    legato: { inBandShare: THRESHOLD?.inBandShare ?? 0.85 },
  },

  constraints: {
    // The default split, which the two-octave spacing above is chosen around.
    splitPoint: 60,
  },

  nodesFor(): string[] {
    return [LEGATO_NODE];
  },

  view(params): PromptView {
    const sharps = sharpsFor(params.key);
    const pitches = legatoPitches(params);
    const root = noteNameOf(pitches[0]!, { sharps });
    return {
      primary: `${params.key} five-finger`,
      secondary: `${HAND_NAME[params.hand]}, thumb on ${root} - up and down, dry piano`,
      answer: pitches
        .slice(0, PENTACHORD.length)
        .map((p) => noteNameOf(p, { sharps }))
        .join(' '),
      // The reference is the position, not the pattern: hearing the five notes
      // is what tells you where the hand goes.
      audition: pitches.slice(0, PENTACHORD.length),
      sharps,
    };
  },

  label(params): string {
    return `${params.key} five-finger, ${HAND_NAME[params.hand]}`;
  },
};
