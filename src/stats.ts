/**
 * Numeric helpers shared by the clock and the graders.
 *
 * These live outside both modules because the grader must not depend on the
 * audio stack: `grade/` is pure arithmetic over event arrays and is tested in a
 * node environment with no AudioContext, no Tone, and no MessageChannel.
 */

/** Middle value, or the mean of the two middle values. NaN for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Linear-interpolated percentile, `q` in 0..1. NaN for an empty list.
 *
 * Interpolated rather than nearest-rank because architecture.md section 9 asks
 * for p25/p75 of the user's own overlap distribution and for the p90 of his
 * timing errors, and those are read off samples of a few dozen: a nearest-rank
 * p25 over 30 values can only ever land on one of thirty numbers, which makes a
 * recalibrated band jump when it should drift.
 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}
