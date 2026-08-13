/**
 * Turning a mismatch into an itemised account of what went wrong
 * (architecture.md section 4).
 *
 * The distinction this file exists to preserve: a note that is absent and a
 * note that is present-but-wrong are different mistakes, and reporting three
 * missing notes plus three extra notes when the user played the wrong chord is
 * both true and useless. Missing and extra notes are paired by nearest pitch
 * into substitutions, which is the form the feedback can actually be read in
 * ("you played G where Ab was expected"), and only genuinely unpaired notes are
 * left as missing or extra.
 */

import type { NoteErrors, Weights } from './types.ts';
import { DEFAULT_WEIGHTS } from './types.ts';

/**
 * Distance used for pairing. In pitch-class space it is circular, so B and C
 * are one semitone apart rather than eleven: an octave-equivalent drill has no
 * notion of "up", and pairing B with a distant note instead of the C next to it
 * would misattribute the error.
 */
export function pitchDistance(a: number, b: number, octaveEquivalent: boolean): number {
  const d = Math.abs(a - b);
  return octaveEquivalent ? Math.min(d % 12, 12 - (d % 12)) : d;
}

/**
 * Compare two note sets, both already reduced to the drill's match space.
 *
 * Pairing is greedy over the smallest distance first, ties broken by pitch so
 * the same input always produces the same report. Greedy rather than optimal:
 * these sets have three or four elements, and an assignment algorithm would be
 * more code than the problem deserves.
 */
export function diffNotes(
  expected: readonly number[],
  played: readonly number[],
  octaveEquivalent = false
): NoteErrors {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missing = expected.filter((p) => !playedSet.has(p));
  const extra = played.filter((p) => !expectedSet.has(p));

  const candidates: { d: number; e: number; p: number }[] = [];
  for (const e of missing) {
    for (const p of extra) {
      candidates.push({ d: pitchDistance(e, p, octaveEquivalent), e, p });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.e - b.e || a.p - b.p);

  const usedExpected = new Set<number>();
  const usedPlayed = new Set<number>();
  const wrong: { expected: number; played: number }[] = [];

  for (const c of candidates) {
    if (usedExpected.has(c.e) || usedPlayed.has(c.p)) continue;
    usedExpected.add(c.e);
    usedPlayed.add(c.p);
    wrong.push({ expected: c.e, played: c.p });
  }

  wrong.sort((a, b) => a.expected - b.expected);

  return {
    missing: missing.filter((p) => !usedExpected.has(p)),
    extra: extra.filter((p) => !usedPlayed.has(p)),
    wrong,
  };
}

export function isClean(errors: NoteErrors): boolean {
  return (
    errors.missing.length === 0 && errors.extra.length === 0 && errors.wrong.length === 0
  );
}

/**
 * Identity score, 0..1: the share of the union of the two note sets that both
 * sets agree on.
 *
 * Deliberately soft, and deliberately not load-bearing. `GradeResult.correct`
 * is what the scheduler reads; this number exists so the UI can distinguish
 * "one note off" from "wrong chord entirely", and architecture.md's repLog does
 * not store it. If it ever starts driving scheduling, it needs calibrating
 * first.
 */
export function identityScore(
  expected: readonly number[],
  played: readonly number[]
): number {
  const expectedSet = new Set(expected);
  const playedSet = new Set(played);
  if (expectedSet.size === 0 && playedSet.size === 0) return 1;
  let intersection = 0;
  for (const p of playedSet) if (expectedSet.has(p)) intersection += 1;
  const union = expectedSet.size + playedSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Combine the components a drill actually produced into one 0..1 score.
 *
 * Weights are renormalised over the components present, so an untimed drill
 * with no grid and no articulation to measure scores purely on identity instead
 * of being capped at 0.6 by the missing two thirds of the default weighting.
 */
export function weightedScore(
  components: Partial<Record<keyof Weights, number>>,
  weights: Weights = DEFAULT_WEIGHTS
): number {
  let total = 0;
  let weighted = 0;
  const entries = Object.entries(components) as [keyof Weights, number | undefined][];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const w = weights[key];
    total += w;
    weighted += w * value;
  }
  return total === 0 ? 0 : weighted / total;
}
