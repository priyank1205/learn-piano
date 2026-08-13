/**
 * The grading layer's public surface.
 *
 * One grader contract, six grader families, one of them built. `set` covers
 * every untimed drill, which is four of the seven V1 nodes; the timed families
 * arrive with the drills that need them. `GRADERS` is a registry rather than a
 * switch so that adding one is adding a file, and so a drill template naming a
 * grader that does not exist yet fails loudly at lookup instead of quietly
 * scoring zero.
 */

export * from './types.ts';
export * from './preprocess.ts';
export * from './match.ts';
export {
  gradeSet,
  settledAnswer,
  setGrader,
  WRONG_INVERSION_SCORE_FACTOR,
} from './set.ts';
export { runner, useGradeRunner } from './runner.ts';
export type { PendingPrompt, Rep, RunnerState } from './runner.ts';

import { setGrader } from './set.ts';
import type { Grader, GraderId } from './types.ts';

export const GRADERS: Partial<Record<GraderId, Grader>> = {
  set: setGrader,
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
