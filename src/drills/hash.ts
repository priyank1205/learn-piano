/**
 * Stable item ids (architecture.md section 2: `itemId = stableHash(templateId +
 * params)`).
 *
 * The property that matters is not secrecy or distribution, it is that the id
 * for "Db major, 1st inversion" is the same string today, after a reload, and
 * after a refactor six months from now. Item ids are the primary key of the SRS
 * state that arrives with the store slice: change how one is derived and every
 * rep already logged against it is orphaned, silently, with no error anywhere.
 *
 * Two consequences are enforced here rather than left to callers:
 *
 *  1. Params are canonicalised with their keys sorted, so reordering the keys
 *     of a `paramSpace` declaration cannot reassign every id in the deck.
 *  2. Values are serialised through JSON, so the number 1 and the string "1"
 *     hash differently. They are different params and would otherwise collide.
 *
 * `drills/pool.test.ts` pins a few known ids as literals. That test failing is
 * the intended alarm, not an inconvenience: it means existing history is about
 * to be stranded, and the fix is a migration, not a new expectation.
 */

import type { DrillParams } from './types.ts';

/**
 * FNV-1a, 32 bits. Not cryptographic and not trying to be. `Math.imul` keeps
 * the multiply in 32-bit integer space, which is what makes the result
 * identical on every engine.
 */
function fnv1a(input: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Two passes from different offset bases, concatenated in base 36. One 32-bit
 * hash would put a collision somewhere around ten thousand items, which is not
 * far enough away for a value that silently merges two items' histories when it
 * happens. Two passes are not fully independent, but they move the horizon
 * further than this app will ever need.
 */
export function stableHash(input: string): string {
  const a = fnv1a(input, 0x811c9dc5);
  const b = fnv1a(input, 0x7fffffff);
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0');
}

/** Params as one deterministic string: keys sorted, values JSON-tagged. */
export function canonicalParams(params: DrillParams): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join(',');
}

export function itemIdOf(templateId: string, params: DrillParams): string {
  return stableHash(`${templateId}|${canonicalParams(params)}`);
}
