/**
 * The `sequence` grader: drills played against a grid (architecture.md section
 * 4, "Timed drills").
 *
 * The `set` grader asks one question, "were those the right notes". This one
 * asks two, and the second is the whole difficulty: **was it in the right
 * place**. Section 4 opens by naming the failure it is written against, "this is
 * where naive implementations feel unfair", and every rule below exists to keep
 * one kind of mistake from being reported as another:
 *
 *  - A note in the right place with the wrong pitch is a **wrong note**.
 *  - The right pitch a little outside the window is **late or early**, with the
 *    error recorded and a small penalty. It is not a wrong note, and calling it
 *    one is how a rhythm drill teaches a person to distrust it.
 *  - The right pitch far outside the window is **missing**, and whatever was
 *    played instead is **extra**.
 *
 * Three decisions here are not spelled out in section 4 and are load-bearing.
 *
 * **The window comes from the inter-onset interval, and the IOI comes from the
 * expected events.** Section 4 defines `IOI = 60000 / (bpm * notesPerBeat)` but
 * `notesPerBeat` is a field of the mastery threshold, not of a performance. The
 * smallest step between consecutive `atBeat` values is the same number and is
 * already in the spec being graded, so it is read from there. A drill whose
 * subdivision changes mid-phrase gets the window of its shortest note, which is
 * the strict reading.
 *
 * **Matching is greedy in time order and each cluster is consumed once**
 * (section 4.5). Not DTW: "overkill at these tempos".
 *
 * **Anything outside the grid is not graded at all.** The count-in is real time
 * during which a musician taps along, and there is no honest way to call that an
 * extra note. Clusters before the first beat's window or after the last one's
 * are ignored rather than punished, which is why `correct` cannot be gamed by
 * playing a wall of notes: everything inside the grid still has to match.
 */

import type { NormalizedEvent } from '../midi.ts';
import { clusterNoteOns, applyTranspose, matchSpace } from './preprocess.ts';
import type { Cluster } from './preprocess.ts';
import { diffNotes, isClean, weightedScore } from './match.ts';
import { DEFAULT_WEIGHTS, ioiMs, timingWindowMs, withTolerances } from './types.ts';
import type {
  DrillInstance,
  EventGrade,
  EventStatus,
  ExpectedEvent,
  GradeContext,
  GradeResult,
  Grader,
  NoteErrors,
  PassCriteria,
  TimingStats,
  Tolerances,
} from './types.ts';

/** Everything the matcher needs about one expected event, already placed in time. */
interface Slot {
  index: number;
  event: ExpectedEvent;
  /** Where this event belongs on the MIDI clock. */
  targetTs: number;
  /** The pitches (or pitch classes) it is matched in. */
  expected: number[];
}

export interface SequenceGrid {
  slots: Slot[];
  /** Half-width of the on-time window, in ms. */
  windowMs: number;
  /** Beyond this, a cluster is not a candidate at all. */
  reachMs: number;
}

/**
 * The subdivision the drill is written in, as notes per beat, read off the
 * expected events. One quarter-note pulse steps by a whole beat and gives 1;
 * eighths step by a half and give 2.
 */
export function notesPerBeatOf(events: readonly ExpectedEvent[]): number {
  let smallest = Infinity;
  for (let i = 1; i < events.length; i += 1) {
    const step = (events[i]!.atBeat ?? i) - (events[i - 1]!.atBeat ?? i - 1);
    if (step > 0) smallest = Math.min(smallest, step);
  }
  return Number.isFinite(smallest) && smallest > 0 ? 1 / smallest : 1;
}

/**
 * Place the expected events on the MIDI clock and size the matching window.
 *
 * Exported because the runner needs the end of the grid to know when the rep is
 * over, and because a grid built two ways is a grid that will disagree with
 * itself on the one rep where it matters.
 */
export function buildGrid(spec: DrillInstance, tol: Tolerances): SequenceGrid {
  const bpm = spec.expected.tempoBpm ?? spec.constraints.tempoBpm ?? 60;
  const events = spec.expected.events;
  const perBeat = notesPerBeatOf(events);
  const beatMs = 60000 / bpm;
  const windowMs = timingWindowMs(ioiMs(bpm, perBeat), tol);
  // A grid with no origin still grades identity: the events land relative to the
  // prompt instead, every timing error is measured from there, and the numbers
  // are meaningless but no worse than that. This only happens when a timed drill
  // is armed without a Transport, which is an authoring bug rather than a
  // performance, and it is visible as a wild `meanAbs` rather than as a crash.
  const origin = spec.gridStartMs ?? spec.promptReadyAt;

  const slots = events.map((event, index) => ({
    index,
    event,
    targetTs: origin + (event.atBeat ?? index / perBeat) * beatMs,
    expected: matchSpace(
      applyTranspose(
        event.pitches,
        spec.constraints.octaveShiftAllowed ? (spec.transposeOffset ?? 0) : 0
      ),
      spec.constraints.octaveEquivalent
    ),
  }));

  return { slots, windowMs, reachMs: windowMs * tol.lateFactor };
}

/** The last instant a note could still count toward this drill. */
export function gridEndsAt(grid: SequenceGrid): number {
  const last = grid.slots[grid.slots.length - 1];
  return last ? last.targetTs + grid.reachMs : -Infinity;
}

function statsOf(errors: readonly number[]): TimingStats | null {
  if (errors.length === 0) return null;
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const meanAbs = errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;
  const variance =
    errors.reduce((a, b) => a + (b - mean) * (b - mean), 0) / errors.length;
  return { mean, meanAbs, sd: Math.sqrt(variance) };
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Did this rep clear the node's numeric bar (architecture.md section 7,
 * `timedRun`: "all notes matched, stats under maxima")?
 *
 * Exported and separate from the grading because it is the line the scheduler
 * reads, and because the maxima are among the numbers section 9 expects to be
 * wrong within a fortnight: when they move, this is the one function that has to
 * be re-read.
 */
export function meetsPass(
  matchedShare: number,
  notesClean: boolean,
  timing: TimingStats | null,
  pass: PassCriteria | undefined
): boolean {
  if (!notesClean) return false;
  if (!pass) return true;
  if (matchedShare < pass.noteAccuracy) return false;
  if (pass.meanAbsErrMsMax !== undefined) {
    if (timing === null || timing.meanAbs > pass.meanAbsErrMsMax) return false;
  }
  if (pass.timingSdMsMax !== undefined) {
    if (timing === null || timing.sd > pass.timingSdMsMax) return false;
  }
  return true;
}

/**
 * Grade one timed rep.
 *
 * No `ctx.nowMs` is read, unlike the `set` grader: an untimed rep has to ask
 * whether the last chord has settled yet, and a timed one is bounded by its own
 * grid. Grading the same events halfway through the run and an hour later gives
 * the same answer, with the beats that had not happened yet reported missing.
 */
export function gradeSequence(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  _ctx: GradeContext = {}
): GradeResult {
  const tol = withTolerances(spec.grading.tolerances);
  const weights = spec.grading.weights ?? DEFAULT_WEIGHTS;
  const grid = buildGrid(spec, tol);
  // Not filtered by `promptReadyAt`, unlike the untimed grader, and the
  // difference is a real bug that cost a beat before it was found. An untimed
  // rep starts when the prompt is painted, because nothing before that could be
  // an answer to it. A timed rep is bounded by its own grid, which starts after
  // a count-in and is known before the prompt is even armed. Filtering by the
  // paint as well makes the first beat depend on when the browser got round to
  // compositing: a slow frame lands `promptReadyAt` after beat 0 and the user is
  // told they missed a note they played.
  const raw = [...events];

  const first = grid.slots[0];
  const from = first ? first.targetTs - grid.reachMs : Infinity;
  const to = gridEndsAt(grid);

  // Only what falls inside the grid is graded. See the header: a tap during the
  // count-in is not a wrong note.
  const clusters = clusterNoteOns(raw, tol.chordClusterMs).filter(
    (c) => c.onsetTs >= from && c.onsetTs <= to
  );

  const used = new Set<number>();
  const perEvent: EventGrade[] = [];
  const errors: NoteErrors = { missing: [], extra: [], wrong: [] };
  const timingErrors: number[] = [];
  let matched = 0;
  let spreadMsMax: number | null = null;

  const played = (cluster: Cluster): number[] =>
    matchSpace(cluster.pitches, spec.constraints.octaveEquivalent);

  for (const slot of grid.slots) {
    let hit: { cluster: Cluster; at: number } | null = null;
    let nearMiss: { cluster: Cluster; at: number } | null = null;

    for (let i = 0; i < clusters.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = clusters[i]!;
      const delta = cluster.onsetTs - slot.targetTs;
      if (delta < -grid.reachMs) continue;
      // Clusters are in time order, so once one is past the reach of this slot
      // every later one is too.
      if (delta > grid.reachMs) break;
      if (sameSet(played(cluster), slot.expected)) {
        hit = { cluster, at: i };
        break;
      }
      // Rule 3: a wrong-pitch cluster inside the on-time window is only a wrong
      // note if no correct cluster turns up later in the same window.
      if (nearMiss === null && Math.abs(delta) <= grid.windowMs) {
        nearMiss = { cluster, at: i };
      }
    }

    const chosen = hit ?? nearMiss;
    if (!chosen) {
      errors.missing.push(...slot.expected);
      perEvent.push({
        index: slot.index,
        status: 'missing',
        expected: slot.expected,
        played: [],
        onsetTs: null,
        timingErrorMs: null,
        spreadMs: null,
      });
      continue;
    }

    used.add(chosen.at);
    const { cluster } = chosen;
    const timingErrorMs = cluster.onsetTs - slot.targetTs;
    const playedNotes = played(cluster);
    spreadMsMax = Math.max(spreadMsMax ?? 0, cluster.spreadMs);

    let status: EventStatus;
    if (hit) {
      matched += 1;
      timingErrors.push(timingErrorMs);
      status =
        Math.abs(timingErrorMs) <= grid.windowMs
          ? 'on-time'
          : timingErrorMs > 0
            ? 'late'
            : 'early';
    } else {
      status = 'wrong';
      const diff = diffNotes(
        slot.expected,
        playedNotes,
        spec.constraints.octaveEquivalent
      );
      errors.missing.push(...diff.missing);
      errors.extra.push(...diff.extra);
      errors.wrong.push(...diff.wrong);
    }

    perEvent.push({
      index: slot.index,
      status,
      expected: slot.expected,
      played: playedNotes,
      onsetTs: cluster.onsetTs,
      timingErrorMs,
      spreadMs: cluster.spreadMs,
    });
  }

  // Rule 4: a cluster inside the grid that matched nothing is an extra note.
  for (let i = 0; i < clusters.length; i += 1) {
    if (used.has(i)) continue;
    const cluster = clusters[i]!;
    const playedNotes = played(cluster);
    errors.extra.push(...playedNotes);
    spreadMsMax = Math.max(spreadMsMax ?? 0, cluster.spreadMs);
    perEvent.push({
      index: -1,
      status: 'extra',
      expected: [],
      played: playedNotes,
      onsetTs: cluster.onsetTs,
      timingErrorMs: null,
      spreadMs: cluster.spreadMs,
    });
  }

  const timing = statsOf(timingErrors);
  const matchedShare = grid.slots.length === 0 ? 0 : matched / grid.slots.length;
  const correct = meetsPass(
    matchedShare,
    isClean(errors),
    timing,
    spec.grading.pass ?? { noteAccuracy: 1 }
  );

  return {
    correct,
    score: weightedScore(
      {
        identity: matchedShare,
        // Informational, like every score in this app: `correct` is what the
        // scheduler reads. Full marks inside the on-time window, falling to zero
        // at the edge of the late one.
        timing:
          timing === null
            ? 0
            : Math.max(0, 1 - timing.meanAbs / Math.max(grid.reachMs, 1)),
      },
      weights
    ),
    // Section 5: timed drills have no latency. The bands do not apply and
    // session-generator.md section 2 grades these by the pass rules instead.
    latencyMs: null,
    timingErrorMs: timing,
    noteOverlapMs: null,
    noteErrors: errors,
    spreadMsMax,
    // One hand per item in V1: `pr-pulse-sync` declares `perHand`, which puts
    // each hand in its own item rather than both in one rep. A hands-together
    // drill would fill this, and none exists.
    handOnsetSkewMs: null,
    perEvent,
    raw,
  };
}

/**
 * A timed rep ends when the grid does, not when the playing stops.
 *
 * There is nothing to wait for after the last beat's window closes: a note
 * arriving later is outside the reach of every slot and cannot change any
 * number in the result.
 */
export function sequenceFinished(
  _events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): boolean {
  const grid = buildGrid(spec, withTolerances(spec.grading.tolerances));
  return (ctx.nowMs ?? Infinity) >= gridEndsAt(grid);
}

export const sequenceGrader: Grader = {
  id: 'sequence',
  grade: gradeSequence,
  isFinished: sequenceFinished,
};
