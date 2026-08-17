/**
 * The `set` grader: untimed, flashcard-style drills (architecture.md section 4,
 * "Untimed drills").
 *
 * It answers one question — did the right notes go down together, and if the
 * drill cares about inversions, was the right one on the bottom — and it
 * measures how long that took. That covers four of the seven V1 nodes:
 * kt-geography (one note), kt-triads-root, kt-inv-maj-triads, kt-inv-min-triads.
 *
 * What it deliberately does not do:
 *
 *  - No grid, no timing error, no articulation. There is no tempo in an
 *    untimed drill, so those components are absent rather than zero, and the
 *    score renormalises over what is present.
 *  - No velocity. Every note-on from this instrument is velocity 100.
 *  - No use of `Chord.detect`. The expected notes come from `buildExpected`
 *    deterministically; detection is heuristic and is for the HUD only.
 *
 * Latency is the point of this grader. The user's deficit is speed, not
 * knowledge, so `latencyMs` (prompt ready to chord complete) is what the
 * scheduler grades on once correctness has gated it.
 */

import type { NormalizedEvent } from '../midi.ts';
import {
  clusterNoteOns,
  firstSettledCluster,
  applyTranspose,
  matchSpace,
} from './preprocess.ts';
import type { Cluster } from './preprocess.ts';
import { diffNotes, identityScore, isClean, weightedScore } from './match.ts';
import { DEFAULT_WEIGHTS, withTolerances } from './types.ts';
import type {
  DrillInstance,
  EventGrade,
  GradeContext,
  GradeResult,
  Grader,
  NoteErrors,
  Weights,
} from './types.ts';

/**
 * How much of the identity score survives playing the right notes over the
 * wrong bass. Informational only: `correct` is already false, and nothing in
 * the repLog stores the score. It exists so the UI can say "right chord, wrong
 * inversion" with a number attached instead of showing a bare zero.
 */
export const WRONG_INVERSION_SCORE_FACTOR = 0.5;

const EMPTY_ERRORS = (): NoteErrors => ({ missing: [], extra: [], wrong: [] });

/** Anything played before the prompt was on screen is not an answer to it. */
export function eventsSincePrompt(
  events: readonly NormalizedEvent[],
  spec: DrillInstance
): NormalizedEvent[] {
  return events.filter((e) => e.ts >= spec.promptReadyAt);
}

/**
 * The cluster this rep will be graded on, or null while the user is still
 * playing. Exported because the live runner needs the same answer the grader
 * will reach, to know when the rep is over.
 */
export function settledAnswer(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): Cluster | null {
  const tol = withTolerances(spec.grading.tolerances);
  const clusters = clusterNoteOns(eventsSincePrompt(events, spec), tol.chordClusterMs);
  return firstSettledCluster(clusters, tol.settleMs, ctx.nowMs)?.cluster ?? null;
}

/**
 * Grade one untimed rep.
 *
 * `ctx.nowMs` is how far observation has reached; omit it to mean "the rep is
 * over", which is what re-grading a stored rep from the rawMidi buffer wants.
 * Live, a null answer means the user is still playing, and the runner keeps
 * waiting rather than grading silence as a miss.
 */
export function gradeSet(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): GradeResult {
  const weights = spec.grading.weights ?? DEFAULT_WEIGHTS;
  const { octaveEquivalent, inversionStrict, octaveShiftAllowed } = spec.constraints;

  const raw = eventsSincePrompt(events, spec);

  const expectedEvent = spec.expected.events[0];
  if (!expectedEvent) {
    // An empty expectation is an authoring bug, not a performance. Say so in
    // the result rather than throwing inside a grader.
    return {
      correct: false,
      score: 0,
      latencyMs: null,
      timingErrorMs: null,
      noteOverlapMs: null,
      noteErrors: EMPTY_ERRORS(),
      spreadMsMax: null,
      handOnsetSkewMs: null,
      perEvent: [],
      raw,
    };
  }

  const transposed = applyTranspose(
    expectedEvent.pitches,
    octaveShiftAllowed ? (spec.transposeOffset ?? 0) : 0
  );
  const expectedNotes = matchSpace(transposed, octaveEquivalent);

  const answer = settledAnswer(raw, spec, ctx);

  if (!answer) {
    return unanswered(expectedNotes, raw);
  }

  return gradeCluster(answer, expectedNotes, expectedEvent.bassPc, {
    octaveEquivalent: octaveEquivalent === true,
    inversionStrict: inversionStrict === true,
    promptReadyAt: spec.promptReadyAt,
    weights: weights,
    raw,
  });
}

/** Prompt shown, nothing played, rep closed. Every expected note is missing. */
function unanswered(expectedNotes: number[], raw: NormalizedEvent[]): GradeResult {
  return {
    correct: false,
    score: 0,
    latencyMs: null,
    timingErrorMs: null,
    noteOverlapMs: null,
    noteErrors: { missing: [...expectedNotes], extra: [], wrong: [] },
    spreadMsMax: null,
    handOnsetSkewMs: null,
    perEvent: [
      {
        index: 0,
        status: 'missing',
        expected: expectedNotes,
        played: [],
        onsetTs: null,
        timingErrorMs: null,
        spreadMs: null,
      },
    ],
    raw,
  };
}

function gradeCluster(
  cluster: Cluster,
  expectedNotes: number[],
  bassPc: number | undefined,
  opts: {
    octaveEquivalent: boolean;
    inversionStrict: boolean;
    promptReadyAt: number;
    weights: Weights;
    raw: NormalizedEvent[];
  }
): GradeResult {
  const playedNotes = matchSpace(cluster.pitches, opts.octaveEquivalent);
  const noteErrors = diffNotes(expectedNotes, playedNotes, opts.octaveEquivalent);
  const notesRight = isClean(noteErrors);

  // The lowest key in the answering chord. Held-over notes from before the
  // prompt are not part of the answer, so "sounding" here means "in this
  // cluster" -- the same thing at a keyboard whose sustain the app ignores.
  const lowest = cluster.pitches[0]!;
  const bassOk =
    !opts.inversionStrict || bassPc === undefined || ((lowest % 12) + 12) % 12 === bassPc;

  const identity =
    identityScore(expectedNotes, playedNotes) *
    (bassOk ? 1 : WRONG_INVERSION_SCORE_FACTOR);

  const status: EventGrade['status'] = notesRight
    ? bassOk
      ? 'matched'
      : 'wrong-inversion'
    : 'wrong';

  return {
    correct: notesRight && bassOk,
    score: weightedScore({ identity }, opts.weights),
    // completeTs, not onsetTs: the answer is not given until the last note of
    // the chord is down.
    latencyMs: cluster.completeTs - opts.promptReadyAt,
    timingErrorMs: null,
    noteOverlapMs: null,
    noteErrors,
    spreadMsMax: cluster.spreadMs,
    handOnsetSkewMs: null,
    perEvent: [
      {
        index: 0,
        status,
        expected: expectedNotes,
        played: playedNotes,
        onsetTs: cluster.onsetTs,
        timingErrorMs: null,
        spreadMs: cluster.spreadMs,
      },
    ],
    raw: opts.raw,
  };
}

/**
 * An untimed rep is over once a cluster has settled (architecture.md section 4).
 * The predicate is `settledAnswer` itself, so the runner can never stop
 * listening on a rep this grader would still be waiting on.
 */
export function setFinished(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): boolean {
  return settledAnswer(events, spec, ctx) !== null;
}

export const setGrader: Grader = {
  id: 'set',
  grade: gradeSet,
  isFinished: setFinished,
};
