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
