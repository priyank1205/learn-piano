/**
 * The grading layer's public surface.
 *
 * One grader contract, six grader families, three of them built. `set` covers
 * every untimed drill (the inversion trainer, note-find, ear-id), `sequence`
 * covers everything played against a grid, which in V1 is the pulse drill, and
 * `legato` is `sequence` plus the one measurement finger legato is about; the
 * other three arrive with the drills that need them. `GRADERS` is a registry
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
export {
  OVERLAP_CLASSES,
  OVERLAP_CLASS_LABELS,
  analyseOverlap,
  classifyOverlap,
  gradeLegato,
  legatoFinished,
  legatoGrader,
  pairNotes,
  summariseOverlap,
} from './legato.ts';
export type {
  OverlapAnalysis,
  OverlapClass,
  OverlapSummary,
  Transition,
} from './legato.ts';
export { GRADERS, graderFor } from './graders.ts';
export { runner, useGradeRunner } from './runner.ts';
export type { PendingPrompt, Presenter, Rep, RunnerState } from './runner.ts';
