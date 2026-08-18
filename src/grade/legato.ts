/**
 * The `legato` grader: release timing (architecture.md section 5, "Overlap").
 *
 * The third grader family, and the first one that grades something other than
 * where a note *started*. `set` asks whether the right notes went down and
 * `sequence` asks whether they went down in the right place; this one asks when
 * the previous note came **up**, which is the whole of what finger legato is:
 *
 *     overlap = off(n) - on(n+1)      per melodic transition, per hand
 *
 * Positive is overlap, negative is a gap. The target band is a tolerance
 * (`legatoBandMs`, [10, 60] by default) and the classes either side of it come
 * from section 5: below `detachedGapMs` is detached, up to the band's floor is
 * near-legato, past the band is smeared, and past `smearMs` is held-over, which
 * section 5 names for what it is - the sustain crutch, made visible.
 *
 * Four decisions.
 *
 * **The note matching is `sequence`'s, unchanged.** section 7's legato row reads
 * "clean notes AND inBandShare met", so a legato rep has to answer the timed
 * question first: were these the right notes, on the grid. That is exactly what
 * `gradeSequence` does, so this grader delegates the whole of it and adds one
 * measurement rather than reimplementing the matcher. The consequence worth
 * knowing: a note flagged `late` is still matched, and legato does not care that
 * it was late. Onset timing is the pulse drill's subject, not this one's.
 *
 * **Overlap is measured on the played line, not on the expected one.** section 5
 * says "consecutive melodic notes", and what the user actually played is what
 * has a release. A rep with a wrong note is already `correct: false` from the
 * note matching, so measuring its transitions costs nothing and still tells the
 * user how the hand behaved.
 *
 * **A note that is never released is held-over by definition.** A transition
 * needs `off(n)`, and if note n was still down when observation stopped there is
 * no number to report, only a lower bound. Dropping the transition would flatter
 * exactly the failure this drill exists to catch, so it is classified held-over
 * and the lower bound is what gets recorded. `legatoFinished` gives every
 * release until `smearMs` past the end of the grid to arrive first, so a
 * transition only reaches this rule when the note really was held.
 *
 * **Thumb-under is not reported.** section 5 asks for thumb-under transitions as
 * a separate share and `pr-legato-scales` has a `thumbUnderInBandShare` for it.
 * That node is not V1 and has no drill: a five-finger position has no thumb
 * crossing, so there is nothing to separate out yet. It arrives with the scale
 * drill, which is where standard fingering makes the positions inferable.
 */

import type { Hand, NormalizedEvent } from '../midi.ts';
import { handOf } from '../midi.ts';
import { median, percentile } from '../stats.ts';
import { buildGrid, gradeSequence, gridEndsAt } from './sequence.ts';
import { weightedScore } from './match.ts';
import { DEFAULT_WEIGHTS, withTolerances } from './types.ts';
import type {
  DrillInstance,
  GradeContext,
  GradeResult,
  Grader,
  Tolerances,
} from './types.ts';

/** architecture.md section 5's five bands, in order from too short to too long. */
export type OverlapClass =
  'detached' | 'near-legato' | 'in-band' | 'smeared' | 'held-over';

export const OVERLAP_CLASSES: readonly OverlapClass[] = [
  'detached',
  'near-legato',
  'in-band',
  'smeared',
  'held-over',
];

/** How a class is written on screen. Here so two screens cannot word it differently. */
export const OVERLAP_CLASS_LABELS: Record<OverlapClass, string> = {
  detached: 'detached',
  'near-legato': 'nearly joined',
  'in-band': 'in band',
  smeared: 'smeared',
  'held-over': 'held over',
};

/**
 * One melodic transition: the release of note n against the onset of note n+1.
 */
export interface Transition {
  hand: Hand;
  /** Position of note n in that hand's own line, 0-based. */
  index: number;
  fromPitch: number;
  toPitch: number;
  /** `off(n) - on(n+1)`. Positive is overlap, negative is a gap. */
  overlapMs: number;
  klass: OverlapClass;
  /** Note n was never released: `overlapMs` is a lower bound. See the header. */
  unreleased: boolean;
}

export interface OverlapSummary {
  transitions: number;
  inBand: number;
  inBandShare: number;
  counts: Record<OverlapClass, number>;
  medianMs: number | null;
  /** section 9.1's recalibration inputs, over this sample. Null when empty. */
  p25Ms: number | null;
  p75Ms: number | null;
}

export interface OverlapAnalysis extends OverlapSummary {
  detail: Transition[];
  /** The `GradeResult.noteOverlapMs` shape: one entry per hand that played. */
  byHand: { hand: Hand; transitions: number[] }[];
}

/**
 * Which band an overlap falls in (architecture.md section 5).
 *
 * The two edges of the target band come from `legatoBandMs`, which is a setting
 * rather than a constant because section 9.1 says so in as many words: the band
 * was calibrated off one captured log and the fix, if it is wrong, is to set the
 * edges at the user's own p25/p75 and walk them toward [10, 60] over sessions.
 * `detachedGapMs` and `smearMs` stay tolerances either side of it.
 */
export function classifyOverlap(
  overlapMs: number,
  tol: Tolerances = withTolerances()
): OverlapClass {
  // Normalised rather than destructured straight through: the band is a setting
  // with two free-form number inputs behind it, and a floor typed above the
  // ceiling would otherwise make the target band empty and every join read as
  // out of it. An inverted band is a typo, not an opinion.
  const [a, b] = tol.legatoBandMs;
  const floor = Math.min(a, b);
  const ceil = Math.max(a, b);
  if (overlapMs < tol.detachedGapMs) return 'detached';
  if (overlapMs < floor) return 'near-legato';
  if (overlapMs <= ceil) return 'in-band';
  if (overlapMs <= tol.smearMs) return 'smeared';
  return 'held-over';
}

const emptyCounts = (): Record<OverlapClass, number> => ({
  detached: 0,
  'near-legato': 0,
  'in-band': 0,
  smeared: 0,
  'held-over': 0,
});

/**
 * Summarise a set of overlaps against a band.
 *
 * Takes bare numbers rather than `Transition`s so it can be run over
 * `GradeResult.noteOverlapMs` from a stored rep, which is the shape
 * architecture.md section 5 defines and the only one that survives the store.
 * That is what lets the band be moved and the session re-read against the new
 * one without re-grading anything.
 */
export function summariseOverlap(
  byHand: readonly { hand: Hand; transitions: readonly number[] }[],
  tol: Tolerances = withTolerances()
): OverlapSummary {
  const all: number[] = [];
  const counts = emptyCounts();
  for (const line of byHand) {
    for (const overlapMs of line.transitions) {
      all.push(overlapMs);
      counts[classifyOverlap(overlapMs, tol)] += 1;
    }
  }
  return {
    transitions: all.length,
    inBand: counts['in-band'],
    inBandShare: all.length === 0 ? 0 : counts['in-band'] / all.length,
    counts,
    medianMs: all.length === 0 ? null : median(all),
    p25Ms: all.length === 0 ? null : percentile(all, 0.25),
    p75Ms: all.length === 0 ? null : percentile(all, 0.75),
  };
}

/** One played note, with both ends of it. `offTs` is null if it never came up. */
interface PlayedNote {
  pitch: number;
  onTs: number;
  offTs: number | null;
}

/**
 * Pair every note-on with the note-off that ended it.
 *
 * A pitch may be down more than once in one rep (a re-struck note, or a note
 * held across its own repetition), so opens are kept per pitch in a queue and
 * each note-off closes the oldest one still open. That is the only reading under
 * which a trill produces one release per strike rather than one release for the
 * whole run.
 */
export function pairNotes(events: readonly NormalizedEvent[]): PlayedNote[] {
  const ordered = [...events]
    .filter((e) => e.type === 'on' || e.type === 'off')
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const notes: PlayedNote[] = [];
  const open = new Map<number, PlayedNote[]>();

  for (const e of ordered) {
    if (e.type === 'on') {
      const note: PlayedNote = { pitch: e.pitch, onTs: e.ts, offTs: null };
      notes.push(note);
      const queue = open.get(e.pitch);
      if (queue) queue.push(note);
      else open.set(e.pitch, [note]);
      continue;
    }
    // A note-off with nothing open is an orphan (the note-on was missed, or it
    // was struck before collection started). Nothing to close, nothing to say.
    const closing = open.get(e.pitch)?.shift();
    if (closing) closing.offTs = e.ts;
  }

  return notes;
}

/**
 * Every transition of one rep, per hand.
 *
 * Hands are split by pitch, which is the only split this instrument allows
 * (CLAUDE.md). Only notes whose onset falls inside the grid are lines: a note
 * struck during the count-in is not part of the pattern, and pairing it with the
 * first real note would invent a transition out of the user warming up.
 */
export function analyseOverlap(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  tol: Tolerances = withTolerances()
): OverlapAnalysis {
  const grid = buildGrid(spec, tol);
  const first = grid.slots[0];
  const from = first ? first.targetTs - grid.reachMs : -Infinity;
  const to = gridEndsAt(grid);
  const splitPoint = spec.constraints.splitPoint ?? 60;

  const notes = pairNotes(events).filter((n) => n.onTs >= from && n.onTs <= to);
  // How far observation reached, for the lower bound on an unreleased note.
  const observedTo = events.reduce((latest, e) => Math.max(latest, e.ts), to);

  const lines = new Map<Hand, PlayedNote[]>();
  for (const note of notes) {
    const hand = handOf(note.pitch, splitPoint);
    const line = lines.get(hand);
    if (line) line.push(note);
    else lines.set(hand, [note]);
  }

  const detail: Transition[] = [];
  const byHand: { hand: Hand; transitions: number[] }[] = [];

  for (const hand of ['L', 'R'] as const) {
    const line = lines.get(hand);
    if (!line || line.length < 2) continue;
    line.sort((a, b) => a.onTs - b.onTs);

    const transitions: number[] = [];
    for (let i = 0; i < line.length - 1; i += 1) {
      const current = line[i]!;
      const next = line[i + 1]!;
      const unreleased = current.offTs === null;
      const overlapMs = (current.offTs ?? observedTo) - next.onTs;
      detail.push({
        hand,
        index: i,
        fromPitch: current.pitch,
        toPitch: next.pitch,
        overlapMs,
        // See the header: a note that never came up is held over whatever the
        // lower bound happens to be, because the release was never observed.
        klass: unreleased ? 'held-over' : classifyOverlap(overlapMs, tol),
        unreleased,
      });
      transitions.push(overlapMs);
    }
    byHand.push({ hand, transitions });
  }

  // Recounted from `detail` rather than from `summariseOverlap(byHand)` so the
  // unreleased rule above is reflected in the shares. The two agree on every
  // transition that has a release, which is all of them in a normal rep.
  const counts = emptyCounts();
  for (const t of detail) counts[t.klass] += 1;
  const all = detail.map((t) => t.overlapMs);

  return {
    detail,
    byHand,
    transitions: all.length,
    inBand: counts['in-band'],
    inBandShare: all.length === 0 ? 0 : counts['in-band'] / all.length,
    counts,
    medianMs: all.length === 0 ? null : median(all),
    p25Ms: all.length === 0 ? null : percentile(all, 0.25),
    p75Ms: all.length === 0 ? null : percentile(all, 0.75),
  };
}

/**
 * Grade one legato rep.
 *
 * architecture.md section 7: "clean notes AND inBandShare met". Both halves are
 * needed and neither is enough: the right notes played detached is not legato,
 * and beautifully connected wrong notes are not the exercise. A rep with no
 * transitions at all (nothing played, or one note) cannot meet the share and is
 * not correct, which is the honest reading of a share over an empty sample.
 */
export function gradeLegato(
  events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): GradeResult {
  const tol = withTolerances(spec.grading.tolerances);
  const weights = spec.grading.weights ?? DEFAULT_WEIGHTS;
  const grid = buildGrid(spec, tol);
  const base = gradeSequence(events, spec, ctx);
  const overlap = analyseOverlap(base.raw, spec, tol);

  const target = spec.grading.legato?.inBandShare ?? 0;
  const shareMet = overlap.transitions > 0 && overlap.inBandShare >= target;

  const expectedCount = spec.expected.events.length;
  const matched = base.perEvent.filter(
    (e) => e.status === 'on-time' || e.status === 'late' || e.status === 'early'
  ).length;
  const identity = expectedCount === 0 ? 0 : matched / expectedCount;

  return {
    ...base,
    correct: base.correct && shareMet,
    // The one drill in V1 that produces all three score components. Articulation
    // is the in-band share: architecture.md section 2 names the third weight for
    // exactly this family, and it has had nothing to hold until now.
    score: weightedScore(
      {
        identity,
        timing:
          base.timingErrorMs === null
            ? 0
            : Math.max(0, 1 - base.timingErrorMs.meanAbs / Math.max(grid.reachMs, 1)),
        articulation: overlap.inBandShare,
      },
      weights
    ),
    noteOverlapMs: overlap.byHand,
  };
}

/**
 * A legato rep ends one smear-width after the grid does.
 *
 * `sequence` stops the moment the last beat's window closes, because nothing
 * arriving later can change a match. A release can: the transition into the
 * final note is `off(n) - on(n+1)`, and a note held past the end of the grid is
 * precisely the held-over case this drill exists to measure. Waiting `smearMs`
 * gives every release that could still be classified a chance to arrive, and
 * anything slower than that is held over by definition, so there is nothing to
 * gain by waiting longer.
 */
export function legatoFinished(
  _events: readonly NormalizedEvent[],
  spec: DrillInstance,
  ctx: GradeContext = {}
): boolean {
  const tol = withTolerances(spec.grading.tolerances);
  const grid = buildGrid(spec, tol);
  return (ctx.nowMs ?? Infinity) >= gridEndsAt(grid) + tol.smearMs;
}

export const legatoGrader: Grader = {
  id: 'legato',
  grade: gradeLegato,
  isFinished: legatoFinished,
};
