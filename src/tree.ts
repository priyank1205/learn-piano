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
