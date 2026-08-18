/**
 * The grader registry.
 *
 * A registry rather than a switch so that adding a family is adding a file, and
 * so a template naming a grader that does not exist fails loudly at lookup
 * instead of quietly scoring zero. Three of architecture.md section 2's six
 * exist: `set` for untimed drills, `sequence` for anything played against a
 * grid, and `legato` for release timing, which is `sequence` plus one
 * measurement.
 *
 * Separate from `index.ts` for the same reason the drill registry is: the runner
 * needs to look a grader up, and `index.ts` exports the runner. A cycle through
 * a module that builds state at load time works until an import order changes.
 */

import { setGrader } from './set.ts';
import { sequenceGrader } from './sequence.ts';
import { legatoGrader } from './legato.ts';
import type { Grader, GraderId } from './types.ts';

export const GRADERS: Partial<Record<GraderId, Grader>> = {
  set: setGrader,
  sequence: sequenceGrader,
  legato: legatoGrader,
};

export function graderFor(id: GraderId): Grader {
  const grader = GRADERS[id];
  if (!grader) {
    throw new Error(
      `No grader implemented for '${id}'. Implemented: ${Object.keys(GRADERS).join(', ')}.`
    );
  }
  return grader;
}
