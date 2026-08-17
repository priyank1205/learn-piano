/**
 * Node mastery, unlock state and the active set (session-generator.md sections
 * 1.2, 1.3 and 3).
 *
 * All of it is **derived, never stored authoritatively** (section 1.2). Given
 * the item states and the tree, this file recomputes the whole picture, which
 * is what makes a tolerance change or a re-grade survivable: throw the derived
 * layer away and build it again.
 *
 * One exception is real and is handled rather than argued with. Section 1.3
 * says a node is complete when its "threshold met **once**", and "met once" is
 * not a function of the present state — a node that has since decayed is still
 * complete. That single bit per node is passed in as `completedAt`, and the
 * store stamps it the first time the threshold is observed. Everything else on
 * a `NodeProgress` is computed from scratch.
 */

import type { ItemState } from '../store/types.ts';
import type { Track, TreeNode } from '../tree.ts';
import { NODES, deckFluencyOf, nodeById } from '../tree.ts';
import { itemsForNode } from '../drills/registry.ts';
import type { LatencyBands } from '../grade/index.ts';
import { LATENCY_BANDS } from '../grade/index.ts';
import { hasLatency } from './srs.ts';

/** Unlock at 80%, "not 1.0 — completion tails shouldn't block the frontier". */
export const UNLOCK_MASTERY = 0.8;

/** A complete node whose mastery falls below this raises a decay flag. */
export const DECAY_MASTERY = 0.6;

/** WIP limits on the active set (section 3). */
export const MAX_LEARNING_PER_TRACK = 2;
export const MAX_LEARNING_TOTAL = 5;

/** Only `deckFluency` can be measured by the graders that exist. */
export const MEASURABLE_THRESHOLDS = new Set(['deckFluency']);

export type Lifecycle = 'locked' | 'unlocked' | 'learning' | 'complete';

export interface NodeProgress {
  nodeId: string;
  node: TreeNode;
  track: Track;
  /** Some registered drill produces items for this node. */
  drillable: boolean;
  /** This build can measure this node's threshold type. */
  measurable: boolean;
  /** The denominator for mastery: the curriculum's own declared item count. */
  itemCount: number;
  itemsSeen: number;
  mastered: number;
  mastery: number;
  /** Share of items whose `latEMA` is under the automatic band. */
  automaticShare: number;
  complete: boolean;
  decayed: boolean;
  lifecycle: Lifecycle;
  /** Deps not yet at 80%. Non-empty exactly when `lifecycle` is `locked`. */
  blockedBy: string[];
  /** Deps skipped because nothing can practise them yet. See `unlocked`. */
  bypassedDeps: string[];
  /** Unsatisfied `requires` flags, e.g. `pedal`. */
  missingRequires: string[];
}

/**
 * One item, against one node's threshold (section 1.2):
 * "last 3 reps all correct AND accEMA >= node accuracy AND latEMA inside the
 * node's latency target (deckFluency: latEMA < 1200ms)".
 *
 * `minRepsPerItem` is folded in here rather than left to the node. It is a
 * per-item field of the threshold (architecture.md section 7) and it exists to
 * stop three lucky reps counting as proof, which is a statement about an item.
 */
export function itemMastered(
  state: ItemState,
  node: TreeNode,
  bands: LatencyBands = LATENCY_BANDS
): boolean {
  const deck = deckFluencyOf(node.id);
  if (!deck) return false;
  if (state.status === 'suspended') return false;
  if (state.reps < deck.minRepsPerItem) return false;

  const lastThree = state.history.slice(-3);
  if (lastThree.length < 3 || !lastThree.every((h) => h.correct)) return false;
  if (state.accEMA < deck.accuracy) return false;
  return hasLatency(state) && state.latEMA < bands.automaticMs;
}

/** An item counts toward the automatic share once it has a latency under the band. */
export function itemAutomatic(
  state: ItemState,
  bands: LatencyBands = LATENCY_BANDS
): boolean {
  return hasLatency(state) && state.latEMA < bands.automaticMs;
}

export interface ProgressOptions {
  bands?: LatencyBands;
  /** Node ids stamped complete at some point in the past. */
  completedAt?: Readonly<Record<string, number>>;
  /** `requires` flags the user has satisfied. `hasPedal` fills `pedal`. */
  satisfiedRequires?: readonly string[];
}

/**
 * The whole tree's progress, keyed by node id.
 *
 * Computed in two passes because unlocking reads the deps' mastery, and mastery
 * itself depends on nothing but item state. One pass over the nodes could not
 * guarantee a dep was resolved before its dependent.
 */
export function nodeProgress(
  states: ReadonlyMap<string, ItemState>,
  opts: ProgressOptions = {}
): Map<string, NodeProgress> {
  const bands = opts.bands ?? LATENCY_BANDS;
  const completedAt = opts.completedAt ?? {};
  const satisfied = new Set(opts.satisfiedRequires ?? []);

  const out = new Map<string, NodeProgress>();

  for (const node of NODES) {
    const items = itemsForNode(node.id);
    const drillable = items.length > 0;
    const measurable = MEASURABLE_THRESHOLDS.has(node.masteryThreshold.type);
    // The curriculum's declared count is the denominator, not the pool size:
    // a node is not 100% mastered because only two of its items have drills.
    const declared = typeof node.itemCount === 'number' ? node.itemCount : items.length;
    const itemCount = declared > 0 ? declared : items.length;

    let itemsSeen = 0;
    let mastered = 0;
    let automatic = 0;
    let minReps = Infinity;
    for (const item of items) {
      const state = states.get(item.itemId);
      if (!state) {
        minReps = 0;
        continue;
      }
      itemsSeen += 1;
      minReps = Math.min(minReps, state.reps);
      if (itemMastered(state, node, bands)) mastered += 1;
      if (itemAutomatic(state, bands)) automatic += 1;
    }
    if (items.length === 0) minReps = 0;

    const mastery = itemCount === 0 ? 0 : mastered / itemCount;
    const automaticShare = itemCount === 0 ? 0 : automatic / itemCount;

    const deck = deckFluencyOf(node.id);
    const thresholdMet =
      measurable &&
      drillable &&
      deck !== null &&
      items.length >= itemCount &&
      minReps >= deck.minRepsPerItem &&
      automaticShare >= deck.automaticShare;

    const complete = thresholdMet || completedAt[node.id] !== undefined;

    out.set(node.id, {
      nodeId: node.id,
      node,
      track: node.track,
      drillable,
      measurable,
      itemCount,
      itemsSeen,
      mastered,
      mastery,
      automaticShare,
      complete,
      decayed: complete && mastery < DECAY_MASTERY,
      lifecycle: 'locked',
      blockedBy: [],
      bypassedDeps: [],
      missingRequires: node.requires.filter((r) => !satisfied.has(r)),
    });
  }

  // Second pass: unlock, which reads the first pass's mastery numbers.
  for (const p of out.values()) {
    const { blockedBy, bypassedDeps } = unlockStatus(p.node, out);
    p.blockedBy = blockedBy;
    p.bypassedDeps = bypassedDeps;
    p.lifecycle =
      blockedBy.length > 0 || p.missingRequires.length > 0
        ? 'locked'
        : p.complete
          ? 'complete'
          : 'unlocked';
  }

  return out;
}

/**
 * Which deps are still holding a node shut.
 *
 * **A dep nothing can practise does not gate.** Section 1.3's rule is "every
 * dep at nodeMastery >= 0.80", which assumes every node has a drill. Three of
 * the four V1 keyboard-theory nodes sit behind `kt-geography`, whose drill is
 * slice 6, so the literal rule leaves the day-one queue empty with 72
 * practisable triads sitting unreachable behind it. That is the exact failure
 * the tree's own `v1Patch` was written to fix ("every V1 node sat behind a
 * non-V1 root gate, so the unlock rule left the day-one queue empty"), arriving
 * again for a different reason.
 *
 * So an undrillable dep is bypassed and **named** in `bypassedDeps`, which the
 * progress screen shows. The bypass disappears on its own as the missing drills
 * land: the moment `kt-geography` has items, it gates again like any other dep.
 * A dep that is drillable and merely unmastered still gates, exactly as written.
 */
export function unlockStatus(
  node: TreeNode,
  progress: ReadonlyMap<string, NodeProgress>
): { blockedBy: string[]; bypassedDeps: string[] } {
  const blockedBy: string[] = [];
  const bypassedDeps: string[] = [];

  for (const dep of node.dependsOn) {
    const p = progress.get(dep.id);
    if (!p) continue;
    if (!p.drillable) bypassedDeps.push(dep.id);
    else if (p.mastery < UNLOCK_MASTERY) blockedBy.push(dep.id);
  }
  return { blockedBy, bypassedDeps };
}

const DESCENDANTS = new Map<string, number>();

/**
 * Every node that transitively depends on this one. Promotion priority.
 *
 * Cached because it is called from a sort comparator and the tree is a
 * compile-time constant: recomputing an O(nodes^2) walk on every comparison of
 * every render is the kind of thing that only shows up as "the app feels slow".
 */
export function descendantCount(nodeId: string): number {
  const cached = DESCENDANTS.get(nodeId);
  if (cached !== undefined) return cached;

  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const node of NODES) {
      if (seen.has(node.id)) continue;
      if (node.dependsOn.some((d) => d.id === id)) {
        seen.add(node.id);
        stack.push(node.id);
      }
    }
  }
  DESCENDANTS.set(nodeId, seen.size);
  return seen.size;
}

export interface ActiveSetOptions {
  /** User pins override everything (section 3). */
  pinned?: readonly string[];
}

/**
 * The nodes in play (section 3): unlocked, not complete, capped at 2 per track
 * and 5 overall.
 *
 * The spec describes slots that free up and get promoted into. This derives the
 * set from a total ordering instead of storing slot occupancy, which behaves
 * identically — a node only ever leaves by completing, and the ordering (pinned,
 * then `isV1`, then descendant count, then id) is stable — while keeping the
 * whole picture reconstructable, as section 1.2 requires.
 *
 * The load guard ("never promote a new node if yesterday's session accuracy was
 * < 75%") is not applied here, because with a derived set there is no promotion
 * event to withhold. It lives where the weight actually enters: the new-item
 * faucet in `select.ts`, which is the only way a node adds anything to a
 * session.
 *
 * Writes `lifecycle: 'learning'` onto the chosen entries of the map it was
 * given. That is the last step of building the map, not a mutation of shared
 * state: `nodeProgress` returns a fresh map every call and `nodeWeight` reads
 * the field this sets. `deriveProgress` does both in the right order.
 */
export function activeNodes(
  progress: ReadonlyMap<string, NodeProgress>,
  opts: ActiveSetOptions = {}
): NodeProgress[] {
  const pinned = new Set(opts.pinned ?? []);

  const candidates = [...progress.values()]
    .filter((p) => p.lifecycle === 'unlocked' && p.drillable && p.measurable)
    .sort((a, b) => {
      const pin = Number(pinned.has(b.nodeId)) - Number(pinned.has(a.nodeId));
      if (pin !== 0) return pin;
      const v1 = Number(b.node.isV1 === true) - Number(a.node.isV1 === true);
      if (v1 !== 0) return v1;
      const desc = descendantCount(b.nodeId) - descendantCount(a.nodeId);
      if (desc !== 0) return desc;
      return a.nodeId.localeCompare(b.nodeId);
    });

  const perTrack = new Map<Track, number>();
  const chosen: NodeProgress[] = [];
  for (const p of candidates) {
    if (chosen.length >= MAX_LEARNING_TOTAL) break;
    const n = perTrack.get(p.track) ?? 0;
    if (n >= MAX_LEARNING_PER_TRACK) continue;
    perTrack.set(p.track, n + 1);
    chosen.push(p);
  }

  for (const p of chosen) p.lifecycle = 'learning';
  return chosen;
}

/** section 4's `nodeWeight`: learning 1.5, decay-flagged 1.3, maintenance 1.0. */
export function nodeWeight(p: NodeProgress | undefined): number {
  if (!p) return 1;
  if (p.lifecycle === 'learning') return 1.5;
  if (p.decayed) return 1.3;
  return 1;
}

/** The heaviest of an item's nodes, since an item can belong to several. */
export function itemNodeWeight(
  nodeIds: readonly string[],
  progress: ReadonlyMap<string, NodeProgress>
): number {
  let weight = 0;
  for (const id of nodeIds) weight = Math.max(weight, nodeWeight(progress.get(id)));
  return weight === 0 ? 1 : weight;
}

/** Nodes whose progress is worth showing: drillable, or on the V1 frontier. */
export function visibleNodes(
  progress: ReadonlyMap<string, NodeProgress>
): NodeProgress[] {
  return [...progress.values()].filter(
    (p) => p.drillable || p.node.isV1 === true || p.itemsSeen > 0
  );
}

export interface DerivedProgress {
  progress: Map<string, NodeProgress>;
  active: NodeProgress[];
}

/**
 * The whole derived layer in one call, in the only order that is correct:
 * mastery, then unlock, then the active set, which is what stamps `learning`
 * and therefore what `nodeWeight` depends on.
 */
export function deriveProgress(
  states: ReadonlyMap<string, ItemState>,
  opts: ProgressOptions & ActiveSetOptions = {}
): DerivedProgress {
  const progress = nodeProgress(states, opts);
  const active = activeNodes(progress, opts);
  return { progress, active };
}

export { nodeById };
