/**
 * The drill schema (architecture.md section 2).
 *
 * "Drills are data": a drill is a `DrillTemplate` object, and the cartesian
 * product of its `paramSpace` is its item pool. Adding a second drill must not
 * require touching the engine, so everything the engine needs is declared here
 * and nothing about a specific drill leaks into the runner or the screens.
 *
 * Two places this deviates from the written spec, both deliberate, both
 * load-bearing.
 *
 * **`nodesFor` returns a list.** architecture.md gives a template a `nodeIds`
 * array (the nodes the drill can exercise) but never says which of them a
 * single item belongs to, and session-generator.md section 1.1 assumes one node
 * per item by hashing ids from `(nodeId, params)`. The tree decides it:
 * kt-triads-root declares 24 items and kt-inv-maj-triads declares 36, over a
 * pool of only 72 distinct triads, so root-position triads are claimed by two
 * nodes at once. Membership is therefore many-to-many and derived from the
 * params. The alternative, one item per (node, params) pair, would schedule the
 * identical physical task twice under two ids.
 *
 * **`view` exists.** architecture.md names a PromptRenderer and gives templates
 * a `promptMode`, but a mode alone cannot render anything. The template owns the
 * string on screen, or every new drill edits the trainer.
 */

import type {
  DrillConstraints,
  ExpectedPerformance,
  GradingSpec,
  Tolerances,
} from '../grade/index.ts';
import type { PendingPrompt } from '../grade/index.ts';
import { itemIdOf } from './hash.ts';

/** Params are flat and primitive so they can be hashed and stored verbatim. */
export type ParamValue = string | number;
export type DrillParams = Record<string, ParamValue>;

/** The declared alternatives per param. Their product is the item pool. */
export type ParamSpace<P extends DrillParams> = {
  readonly [K in keyof P]: readonly P[K][];
};

export type PromptMode = 'text' | 'chord-symbol' | 'notation-lite' | 'audio';

/**
 * `choice` exists so ear skills can be measured without keyboard fluency
 * contaminating them (architecture.md section 2). Nothing in V1 uses it yet.
 */
export type AnswerMode = 'play' | 'choice';

/** Everything a screen needs to show one item, produced by the template. */
export interface PromptView {
  /** The large glyph: a chord symbol, a note name. */
  primary: string;
  /** One short line under it. */
  secondary: string;
  /**
   * The answer, revealed only after a rep is graded. Never shown while the
   * clock is running: latency is the measurement, and a visible answer would
   * measure reading speed instead.
   */
  answer: string;
  /**
   * A reference voicing, for the "hear it" button and the reveal. Playback
   * never re-enters the MIDI stream, so it cannot influence a grade.
   */
  audition: number[];
  /** Sharps or flats, so played notes are reported back in the prompt's spelling. */
  sharps: boolean;
}

export interface DrillTemplate<P extends DrillParams = DrillParams> {
  id: string;
  /** Shown wherever a drill is named in the UI. */
  name: string;
  /** Every skill-tree node this drill can exercise. `nodesFor` narrows per item. */
  nodeIds: readonly string[];
  promptMode: PromptMode;
  answerMode: AnswerMode;
  paramSpace: ParamSpace<P>;
  /** Expected pitches, deterministic, via tonal only. Never `Chord.detect`. */
  buildExpected(params: P): ExpectedPerformance;
  grading: GradingSpec;
  constraints: DrillConstraints;
  /** Which nodes this item counts toward. A subset of `nodeIds`, never empty. */
  nodesFor(params: P): string[];
  view(params: P): PromptView;
  /** Human-readable item name, for the UI and for reading a log by eye. */
  label(params: P): string;
}

/** One point in the param space, with its stable id resolved. */
export interface DrillItem<P extends DrillParams = DrillParams> {
  itemId: string;
  templateId: string;
  params: P;
  nodeIds: readonly string[];
  label: string;
}

export function makeItem<P extends DrillParams>(
  template: DrillTemplate<P>,
  params: P
): DrillItem<P> {
  return {
    itemId: itemIdOf(template.id, params),
    templateId: template.id,
    params,
    nodeIds: template.nodesFor(params),
    label: template.label(params),
  };
}

/**
 * An item as a rep the runner can arm. `promptReadyAt` is deliberately absent:
 * only the runner knows when the prompt was painted, and latency is measured
 * from that moment rather than from this one.
 */
export function instantiate<P extends DrillParams>(
  template: DrillTemplate<P>,
  item: DrillItem<P>,
  tolerances?: Partial<Tolerances>
): PendingPrompt {
  return {
    itemId: item.itemId,
    drillId: template.id,
    nodeIds: item.nodeIds,
    expected: template.buildExpected(item.params),
    grading: tolerances
      ? {
          ...template.grading,
          tolerances: { ...template.grading.tolerances, ...tolerances },
        }
      : template.grading,
    constraints: template.constraints,
  };
}
