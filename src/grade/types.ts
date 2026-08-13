/**
 * The grader contract (architecture.md sections 2, 4 and 5) and every tolerance
 * number the app grades with.
 *
 * This file is types and constants only, on purpose: the numbers in
 * `DEFAULT_TOLERANCES` and `LATENCY_BANDS` are the ones architecture.md section
 * 9 predicts will be wrong in the first two weeks, so they exist exactly once,
 * in a shape a drill template can override per-drill and a settings screen can
 * override globally. Nothing downstream may inline 80, 300, 1200 or 3000.
 */

import type { Hand, NormalizedEvent } from '../midi.ts';

/** The six grader families in architecture.md section 2. Only `set` exists yet. */
export type GraderId = 'set' | 'sequence' | 'legato' | 'sync' | 'piece' | 'pedal';

export interface ExpectedEvent {
  /** MIDI numbers, or pitch classes when the drill declares `octaveEquivalent`. */
  pitches: number[];
  /** Omitted for untimed (flashcard-style) drills. */
  atBeat?: number;
  hand?: Hand;
  /** For `inversionStrict`: the pitch class that must be sounding lowest. */
  bassPc?: number;
}

export interface ExpectedPerformance {
  /** Ordered. Untimed drills carry exactly one. */
  events: ExpectedEvent[];
  /** Present => timed grading. */
  tempoBpm?: number;
}

export interface Weights {
  identity: number;
  timing: number;
  articulation: number;
}

/** architecture.md section 2. Components a drill cannot produce are dropped and
 *  the rest renormalised, so an untimed drill scores purely on identity. */
export const DEFAULT_WEIGHTS: Weights = {
  identity: 0.6,
  timing: 0.25,
  articulation: 0.15,
};

export interface DrillConstraints {
  /** Hands are indistinguishable at the protocol level; this is the only split. */
  splitPoint?: number;
  /** Chord identity in any octave: match on pitch classes. */
  octaveEquivalent?: boolean;
  /** The whole expected pattern may sit at the app transpose offset (61 keys). */
  octaveShiftAllowed?: boolean;
  /** Lowest sounding pitch class must equal the expected `bassPc`. */
  inversionStrict?: boolean;
  tempoBpm?: number;
}

/**
 * architecture.md section 4. `settleMs` is the one addition: the untimed rule in
 * that section ("no new note-ons for 300ms") is a tolerance in everything but
 * name, and the inversion trainer is untimed, so it lives here with the rest
 * rather than as a literal inside the set grader.
 */
export interface Tolerances {
  /** Note-ons within this of the cluster start are one chord. */
  chordClusterMs: number;
  /** Untimed drills: silence this long after a cluster means the answer is in. */
  settleMs: number;
  /** timingWindowMs = clamp(floor, factor * IOI, ceil). */
  timingWindowFactor: number;
  timingWindowFloorMs: number;
  timingWindowCeilMs: number;
  /** Within +-W is on time; within +-lateFactor*W is late/early; beyond is a miss. */
  lateFactor: number;
  legatoBandMs: readonly [number, number];
  /** Overlap below this is a detached transition. */
  detachedGapMs: number;
  /** Overlap above this is a held-over note: the sustain crutch, made visible. */
  smearMs: number;
  staccatoDuty: readonly [number, number];
}

export const DEFAULT_TOLERANCES: Tolerances = {
  chordClusterMs: 80,
  settleMs: 300,
  timingWindowFactor: 0.25,
  timingWindowFloorMs: 40,
  timingWindowCeilMs: 120,
  lateFactor: 2,
  legatoBandMs: [10, 60],
  detachedGapMs: -20,
  smearMs: 120,
  staccatoDuty: [0.3, 0.5],
};

export function withTolerances(overrides?: Partial<Tolerances>): Tolerances {
  return overrides ? { ...DEFAULT_TOLERANCES, ...overrides } : DEFAULT_TOLERANCES;
}

/**
 * The matching window for one expected event, from the inter-onset interval.
 * Windows scale with tempo through IOI, floored below human relevance and
 * capped so that slow tempos cannot forgive rhythm entirely.
 */
export function timingWindowMs(
  ioiMs: number,
  tol: Tolerances = DEFAULT_TOLERANCES
): number {
  const scaled = tol.timingWindowFactor * ioiMs;
  return Math.min(Math.max(tol.timingWindowFloorMs, scaled), tol.timingWindowCeilMs);
}

/** Inter-onset interval implied by a tempo and a subdivision. */
export function ioiMs(bpm: number, notesPerBeat: number): number {
  return 60000 / (bpm * notesPerBeat);
}

export interface LatencyBands {
  automaticMs: number;
  knownMs: number;
}

/**
 * The single home of the latency bands. Mirrors `meta.latencyBandsMs` in
 * skill-tree.json, which `types.test.ts` asserts.
 *
 * architecture.md section 9.3 expects these to need scaling by answer size
 * (`1200 + 150 * (notes - 1)` is the first thing to try) once big chords are
 * being graded. That is why every consumer takes the bands as an argument
 * instead of reading the constant.
 */
export const LATENCY_BANDS: LatencyBands = { automaticMs: 1200, knownMs: 3000 };

export type LatencyBand = 'automatic' | 'known' | 'not-known';

/** How a band is written on screen. Here so two screens cannot word it differently. */
export const LATENCY_BAND_LABELS: Record<LatencyBand, string> = {
  automatic: 'automatic',
  known: 'known',
  'not-known': 'not known',
};

export const latencyBandLabel = (band: LatencyBand): string => LATENCY_BAND_LABELS[band];

export function latencyBand(
  latencyMs: number | null,
  bands: LatencyBands = LATENCY_BANDS
): LatencyBand | null {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return null;
  if (latencyMs < bands.automaticMs) return 'automatic';
  if (latencyMs <= bands.knownMs) return 'known';
  return 'not-known';
}

export interface GradingSpec {
  graderId: GraderId;
  weights?: Weights;
  tolerances?: Partial<Tolerances>;
}

/**
 * One rep, ready to grade. The template (architecture.md section 2) plus the
 * params it was instantiated with, already reduced to expected events.
 */
export interface DrillInstance {
  itemId: string;
  drillId: string;
  /**
   * The tree nodes this item counts toward. Plural because the tree's own item
   * counts require it: kt-triads-root declares 24 items and kt-inv-maj-triads
   * 36, over a pool of 72 distinct triads, so a root-position triad is claimed
   * by both. See `drills/types.ts` for the full reasoning. The graders ignore
   * this field; it is here so a rep can be attributed without re-deriving the
   * item from its id.
   */
  nodeIds: readonly string[];
  expected: ExpectedPerformance;
  grading: GradingSpec;
  constraints: DrillConstraints;
  /**
   * Render complete for visual prompts, end of playback for ear prompts.
   * Latency is measured from here, so it never includes listening time.
   */
  promptReadyAt: DOMHighResTimeStamp;
  /** App-level transpose the user set for the 61-key window. Applied to expected. */
  transposeOffset?: number;
}

export type EventStatus =
  /** Untimed drills: the notes were right and there is no grid to be early of. */
  | 'matched'
  | 'on-time'
  | 'late'
  | 'early'
  | 'wrong'
  | 'missing'
  | 'extra'
  /** Right notes, wrong bass, under `inversionStrict`. */
  | 'wrong-inversion';

export interface EventGrade {
  /** Index into `expected.events`, or -1 for an extra cluster matching nothing. */
  index: number;
  status: EventStatus;
  /** Pitches or pitch classes, whichever this drill matches on. */
  expected: number[];
  played: number[];
  onsetTs: number | null;
  timingErrorMs: number | null;
  spreadMs: number | null;
}

export interface TimingStats {
  mean: number;
  meanAbs: number;
  sd: number;
}

export interface NoteErrors {
  missing: number[];
  extra: number[];
  wrong: { expected: number; played: number }[];
}

export interface GradeResult {
  /** Per the node's accuracy definition. This, not `score`, gates the scheduler. */
  correct: boolean;
  /** 0..1, weighted. Informational in V1: nothing in the repLog stores it. */
  score: number;
  /** Untimed: promptReadyAt -> answer cluster completeTs. Timed: null. */
  latencyMs: number | null;
  timingErrorMs: TimingStats | null;
  noteOverlapMs: { hand: Hand; transitions: number[] }[] | null;
  noteErrors: NoteErrors;
  /** Worst rolled-chord spread this rep. Recorded, never punished. */
  spreadMsMax: number | null;
  handOnsetSkewMs: number | null;
  perEvent: EventGrade[];
  /** Kept so a tolerance change can re-grade this rep (architecture.md section 8). */
  raw: NormalizedEvent[];
}

/**
 * architecture.md section 5 writes this as `grade(events, spec)`. The optional
 * context is the one addition, and it exists because that signature assumes the
 * rep is over: it cannot express "the user has played a chord and 120ms have
 * passed, is that the answer yet?".
 *
 * `nowMs` defaults to Infinity, meaning "no more events are coming", so
 * re-grading a stored rep from the rawMidi buffer uses the documented two-
 * argument form and gets the same answer the live grade gave.
 */
export interface GradeContext {
  nowMs?: number;
}

export interface Grader {
  id: GraderId;
  grade(
    events: readonly NormalizedEvent[],
    spec: DrillInstance,
    ctx?: GradeContext
  ): GradeResult;
}
