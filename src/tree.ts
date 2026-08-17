/**
 * The skill tree, read from `docs/skill-tree.json`.
 *
 * The curriculum is data and the JSON is the source of truth (CLAUDE.md), so
 * the app imports it rather than restating any of it. Node names, item counts
 * and mastery thresholds on screen are the document's own, which means a
 * decision changed in the tree shows up in the UI with no code edit, and a
 * disagreement between the two is impossible rather than merely unlikely.
 *
 * The one cast is at the boundary below. `masteryThreshold` is a union of ten
 * shapes across the 53 nodes (architecture.md section 7), so TypeScript infers
 * the JSON as a union of node types that cannot be indexed uniformly. The cast
 * names that union once, here, instead of at every call site.
 */

import treeJson from '../docs/skill-tree.json';

export type Track = 'keyboard-theory' | 'physical-rhythm' | 'ear';

/** Loosely typed on purpose: the fields differ per threshold type. */
export type MasteryThreshold = { type: string } & Record<string, unknown>;

export interface TreeNode {
  id: string;
  track: Track;
  name: string;
  desc: string;
  dependsOn: { id: string; why: string }[];
  masteryThreshold: MasteryThreshold;
  drillType: string;
  /** 'generated' for procedurally infinite nodes. */
  itemCount: number | string;
  sustainSensitive: boolean;
  requires: string[];
  isV1?: boolean;
  notes?: string;
}

interface Tree {
  meta: {
    version: number;
    latencyBandsMs: { automatic: number; known: number };
    tracks: string[];
  };
  nodes: TreeNode[];
}

const tree = treeJson as unknown as Tree;

/** Cache keys in the store are stamped with this (architecture.md section 8). */
export const TREE_VERSION = tree.meta.version;

export const NODES: readonly TreeNode[] = tree.nodes;

const BY_ID = new Map(NODES.map((n) => [n.id, n]));

export function nodeById(id: string): TreeNode | undefined {
  return BY_ID.get(id);
}

/** The node's name, or its id if the tree has never heard of it. */
export function nodeName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function v1Nodes(): TreeNode[] {
  return NODES.filter((n) => n.isV1 === true);
}

/**
 * `deckFluency` thresholds, typed, for the nodes the V1 decks use. Returns null
 * for the other nine threshold shapes, so a caller that only understands decks
 * cannot accidentally read a tempo target as an accuracy.
 */
export interface DeckFluency {
  accuracy: number;
  automaticShare: number;
  minRepsPerItem: number;
}

export function deckFluencyOf(id: string): DeckFluency | null {
  const t = BY_ID.get(id)?.masteryThreshold;
  if (!t || t.type !== 'deckFluency') return null;
  return {
    accuracy: Number(t.accuracy),
    automaticShare: Number(t.automaticShare),
    minRepsPerItem: Number(t.minRepsPerItem),
  };
}

/**
 * `timedRun` thresholds (architecture.md section 7). The numbers a pass is
 * judged against live in the tree, not in the drill, so a re-tuned tempo target
 * or a widened error budget is a curriculum edit rather than a code edit. The
 * rhythm drill reads its own node's row and hands the per-rep half of it to the
 * grader; the per-node half (`cleanPasses`, `perHand`) stays here.
 */
export interface TimedRun {
  tempoBpm: number;
  notesPerBeat: number;
  noteAccuracy: number;
  meanAbsErrMsMax?: number;
  timingSdMsMax?: number;
  handOnsetSkewMsMax?: number;
  cleanPasses: number;
  perHand: boolean;
}

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const optionalNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function timedRunOf(id: string): TimedRun | null {
  const t = BY_ID.get(id)?.masteryThreshold;
  if (!t || t.type !== 'timedRun') return null;
  return {
    tempoBpm: numberOr(t.tempoBpm, 100),
    notesPerBeat: numberOr(t.notesPerBeat, 1),
    noteAccuracy: numberOr(t.noteAccuracy, 1),
    meanAbsErrMsMax: optionalNumber(t.meanAbsErrMsMax),
    timingSdMsMax: optionalNumber(t.timingSdMsMax),
    handOnsetSkewMsMax: optionalNumber(t.handOnsetSkewMsMax),
    cleanPasses: numberOr(t.cleanPasses, 3),
    perHand: t.perHand === true,
  };
}

/**
 * `earDeck` thresholds (architecture.md section 7). The only threshold shape in
 * the tree that is judged over a **rolling window of recent reps** rather than
 * per item: "answer matches; rolling window". That is why `nodeProgress` takes
 * the rep log as well as the item states.
 */
export interface EarDeck {
  accuracy: number;
  windowItems: number;
  medianResponseMsMax: number;
}

export function earDeckOf(id: string): EarDeck | null {
  const t = BY_ID.get(id)?.masteryThreshold;
  if (!t || t.type !== 'earDeck') return null;
  return {
    accuracy: numberOr(t.accuracy, 0.9),
    windowItems: numberOr(t.windowItems, 40),
    medianResponseMsMax: numberOr(t.medianResponseMsMax, 2500),
  };
}
