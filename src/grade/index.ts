/**
 * The grading layer's public surface.
 *
 * One grader contract, six grader families, two of them built. `set` covers
 * every untimed drill (the inversion trainer, note-find, ear-id) and `sequence`
 * covers everything played against a grid, which in V1 is the pulse drill; the
 * other four arrive with the drills that need them. `GRADERS` is a registry
 * rather than a switch so that adding one is adding a file, and so a drill
 * template naming a grader that does not exist yet fails loudly at lookup
 * instead of quietly scoring zero.
 *
 * `schedule/mastery.ts` keeps the matching list of threshold types this build
 * can measure. The two go together: a grader with no threshold type reports
 * nothing, and a threshold type with no grader reports zero where it means
 * "unbuilt". Adding a family means editing both.
 */

export * from './types.ts';
export * from './preprocess.ts';
export * from './match.ts';
export {
  gradeSet,
  settledAnswer,
  setFinished,
  setGrader,
  WRONG_INVERSION_SCORE_FACTOR,
} from './set.ts';
export {
  buildGrid,
  gradeSequence,
  gridEndsAt,
  meetsPass,
  notesPerBeatOf,
  sequenceFinished,
  sequenceGrader,
} from './sequence.ts';
export type { SequenceGrid } from './sequence.ts';
export { GRADERS, graderFor } from './graders.ts';
export { runner, useGradeRunner } from './runner.ts';
export type { PendingPrompt, Presenter, Rep, RunnerState } from './runner.ts';
