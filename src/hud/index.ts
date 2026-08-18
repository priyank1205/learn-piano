/**
 * The chord HUD: the second of CLAUDE.md's three V1 drills, and the one that is
 * not a drill.
 *
 * It has no items, no prompts and no grader. What it has is a mode
 * (session-generator.md section 8) in which the app watches the user play and
 * learns something from it without asking for anything, which is why it is a
 * screen rather than a `DrillTemplate`: the schema is for things that can be
 * scheduled and graded, and forcing this through it would mean inventing a
 * prompt nobody asked for.
 *
 * Two halves, split by what each is allowed to touch. `chords.ts` decides what
 * is sounding and which item it is; `harvest.ts` decides when a chord has been
 * slow often enough to say so. Neither writes anything: the store's
 * `harvestLatency` does, under the rules in `schedule/srs.ts`.
 */

export {
  CHORD_SETTLE_MS,
  ChordWatcher,
  MIN_CHORD_NOTES,
  attributableShapes,
  attributeChord,
  shapeKey,
} from './chords.ts';
export type { ChordChange, SoundingChord } from './chords.ts';
export { HARVEST_MIN_OBSERVATIONS, Harvest } from './harvest.ts';
export type { HarvestNudge, HarvestRow } from './harvest.ts';
