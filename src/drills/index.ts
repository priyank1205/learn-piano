/**
 * The drill layer's public surface.
 *
 * A drill is a `DrillTemplate` object and nothing else (architecture.md section
 * 2). The schema, the item pool, the registry, the in-session order and the
 * practice loop are all here; what a screen imports is this file, and adding a
 * second drill means adding a template to the registry, not editing an engine.
 */

export * from './types.ts';
export * from './pool.ts';
export * from './queue.ts';
export * from './registry.ts';
export { canonicalParams, itemIdOf, stableHash } from './hash.ts';
export { INVERSION_TRAINER_ID, inversionTrainer } from './inversionTrainer.ts';
export type { InversionParams } from './inversionTrainer.ts';
export { NOTE_FIND_ID, noteFind, keyLabel } from './noteFind.ts';
export type { NoteFindParams } from './noteFind.ts';
export {
  RHYTHM_TAP_ID,
  rhythmTap,
  HAND_PITCH,
  PULSE_BEATS,
  PULSE_COUNT_IN,
} from './rhythmTap.ts';
export type { RhythmTapParams } from './rhythmTap.ts';
export { EAR_ID, earId, CORE_INTERVALS, ROOT_RANGE, earPitches } from './earId.ts';
export type { EarIntervalParams } from './earId.ts';
export { prepareItem, presentItem, stopPresentation } from './present.ts';
export {
  DEFAULT_DECK,
  DEFAULT_DWELL_MS,
  practice,
  scheduledPool,
  summarise,
  usePractice,
} from './practice.ts';
export type {
  ItemStats,
  PracticeEnd,
  PracticeMode,
  PracticeRep,
  PracticeStats,
  PracticeStatus,
  PracticeSummary,
} from './practice.ts';
