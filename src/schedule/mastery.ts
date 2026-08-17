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

import type { ItemState, RepRow } from '../store/types.ts';
import type { Track, TreeNode } from '../tree.ts';
import { NODES, deckFluencyOf, earDeckOf, nodeById, timedRunOf } from '../tree.ts';
import { itemsForNode } from '../drills/registry.ts';
import type { LatencyBands } from '../grade/index.ts';
import { LATENCY_BANDS } from '../grade/index.ts';
import { median } from '../stats.ts';
import { hasLatency } from './srs.ts';

/** Unlock at 80%, "not 1.0 — completion tails shouldn't block the frontier". */
export const UNLOCK_MASTERY = 0.8;

/** A complete node whose mastery falls below this raises a decay flag. */
export const DECAY_MASTERY = 0.6;

/** WIP limits on the active set (section 3). */
export const MAX_LEARNING_PER_TRACK = 2;
export const MAX_LEARNING_TOTAL = 5;

/**
 * The threshold types this build can measure, which is exactly the types the
 * graders that exist can produce (`grade/graders.ts`): `set` grades the decks
 * and the ear deck, `sequence` grades the timed runs. The other seven shapes in
 * architecture.md section 7 report "not built yet" rather than 0%, because a
 * node reading 0% looks like failure and a node with no grader is not being
 * failed at.
 *
 * Adding a grader family means adding its threshold type here. The two lists
 * only make sense together.
 */
export const MEASURABLE_THRESHOLDS = new Set(['deckFluency', 'timedRun', 'earDeck']);

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
  /** `earDeck` nodes only: the rolling window their threshold is read from. */
  window: RepWindow | null;
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

/** section 1.2's "last N reps all correct". N is 3 unless a threshold says more. */
function lastRepsCorrect(state: ItemState, n: number): boolean {
  const recent = state.history.slice(-n);
  return recent.length >= n && recent.every((h) => h.correct);
}

/**
 * One item, against one node's threshold (section 1.2):
 * "last 3 reps all correct AND accEMA >= node accuracy AND latEMA inside the
 * node's latency/tempo target (deckFluency: latEMA < 1200ms; timedRun/legato/
 * sync: last pass met the numeric threshold)".
 *
 * `minRepsPerItem` is folded in here rather than left to the node. It is a
 * per-item field of the threshold (architecture.md section 7) and it exists to
 * stop three lucky reps counting as proof, which is a statement about an item.
 *
 * Three shapes, and the two new ones each needed a reading.
 *
 * **`timedRun` has no accuracy EMA to test.** Its `noteAccuracy: 1.0` is a
 * per-rep rule ("all notes matched", architecture.md section 7) and the grader
 * has already applied it: a rep is `correct` only if every note landed and the
 * timing stats were under the maxima. Reading 1.0 as an `accEMA` threshold
 * instead would make mastery unreachable, since an EMA that has ever seen a miss
 * never returns to 1. So the item's bar is `cleanPasses` consecutive clean
 * passes, which is section 1.2's "last N reps all correct" with N from the tree.
 *
 * **`earDeck`'s latency target is its own.** The 1200ms automatic band is a
 * keyboard-recall number and this deck's target is `medianResponseMsMax`, which
 * is 2500ms because the answer follows a sound the user had to hear first.
 */
export function itemMastered(
  state: ItemState,
  node: TreeNode,
  bands: LatencyBands = LATENCY_BANDS
): boolean {
  if (state.status === 'suspended') return false;

  const deck = deckFluencyOf(node.id);
  if (deck) {
    if (state.reps < deck.minRepsPerItem) return false;
    if (!lastRepsCorrect(state, 3)) return false;
    if (state.accEMA < deck.accuracy) return false;
    return hasLatency(state) && state.latEMA < bands.automaticMs;
  }

  const timed = timedRunOf(node.id);
  if (timed) {
    return state.reps >= timed.cleanPasses && lastRepsCorrect(state, timed.cleanPasses);
  }

  const ear = earDeckOf(node.id);
  if (ear) {
    if (!lastRepsCorrect(state, 3)) return false;
    if (state.accEMA < ear.accuracy) return false;
    return hasLatency(state) && state.latEMA <= ear.medianResponseMsMax;
  }

  return false;
}

/** An item counts toward the automatic share once it has a latency under the band. */
export function itemAutomatic(
  state: ItemState,
  bands: LatencyBands = LATENCY_BANDS
): boolean {
  return hasLatency(state) && state.latEMA < bands.automaticMs;
}

/**
 * A node's last few reps, for the one threshold shape that is judged over a
 * window rather than per item (architecture.md section 7, `earDeck`: "answer
 * matches; rolling window").
 */
export interface RepWindow {
  /** Reps in the window, capped at the threshold's `windowItems`. */
  reps: number;
  accuracy: number;
  /** Median response time over the correct reps, or null before there are any. */
  medianMs: number | null;
}

/**
 * The window an `earDeck` node is judged over.
 *
 * The median is taken over **correct** reps, for the reason `summarise()` and
 * `applyRating` already take latency that way: the time spent playing a wrong
 * note measures nothing, and a fast wrong answer would pull the median down.
 * That is a stricter reading than "median response time" alone, and the strict
 * reading is the one that cannot be gamed by answering quickly and badly.
 */
export function repWindow(
  nodeId: string,
  reps: readonly RepRow[],
  windowItems: number
): RepWindow {
  const mine: RepRow[] = [];
  for (let i = reps.length - 1; i >= 0 && mine.length < windowItems; i -= 1) {
    const row = reps[i]!;
    if (row.nodeIds.includes(nodeId)) mine.push(row);
  }
  const correct = mine.filter((r) => r.correct);
  const latencies = correct
    .map((r) => r.latencyMs)
    .filter((l): l is number => l !== null && l > 0);

  return {
    reps: mine.length,
    accuracy: mine.length === 0 ? 0 : correct.length / mine.length,
    medianMs: latencies.length > 0 ? median(latencies) : null,
  };
}

export interface ProgressOptions {
  bands?: LatencyBands;
  /** Node ids stamped complete at some point in the past. */
  completedAt?: Readonly<Record<string, number>>;
  /** `requires` flags the user has satisfied. `hasPedal` fills `pedal`. */
  satisfiedRequires?: readonly string[];
  /**
   * Recent reps, oldest first, for `earDeck`'s rolling window. Everything else
   * is a function of item state alone; without these an ear node simply reports
   * an empty window and cannot complete.
   */
  reps?: readonly RepRow[];
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
  const reps = opts.reps ?? [];

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

    const ear = earDeckOf(node.id);
    const window = ear ? repWindow(node.id, reps, ear.windowItems) : null;
    const thresholdMet =
      measurable &&
      drillable &&
      // Never complete on a partial pool: a node is not finished because only
      // some of the items the curriculum declares have been built.
      items.length >= itemCount &&
      nodeThresholdMet(node, {
        minReps,
        automaticShare,
        mastered,
        itemCount,
        window,
      });

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
      window,
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
 * Has this node's threshold been met, per its type (section 1.2:
 * "nodeComplete(node) := threshold met per its type")?
 *
 * The three shapes read differently on purpose, because the documents define
 * them differently:
 *
 *  - `deckFluency`: `automaticShare` of the declared items under the automatic
 *    band, with every item having had at least `minRepsPerItem` reps.
 *  - `timedRun`: section 1.2 spells this one out as "cleanPasses recorded for
 *    every item", and `itemMastered` is already exactly that per item, so the
 *    node is complete when all of them are.
 *  - `earDeck`: a rolling window, not a per-item count. A full window at or
 *    above the accuracy, with a median response at or under the maximum.
 */
function nodeThresholdMet(
  node: TreeNode,
  stats: {
    minReps: number;
    automaticShare: number;
    mastered: number;
    itemCount: number;
    window: RepWindow | null;
  }
): boolean {
  const deck = deckFluencyOf(node.id);
  if (deck) {
    return (
      stats.minReps >= deck.minRepsPerItem && stats.automaticShare >= deck.automaticShare
    );
  }

  const timed = timedRunOf(node.id);
  if (timed) return stats.itemCount > 0 && stats.mastered >= stats.itemCount;

  const ear = earDeckOf(node.id);
  if (ear) {
    const w = stats.window;
    return (
      w !== null &&
      w.reps >= ear.windowItems &&
      w.accuracy >= ear.accuracy &&
      w.medianMs !== null &&
      w.medianMs <= ear.medianResponseMsMax
    );
  }

  return false;
}

/**
 * Which deps are still holding a node shut.
 *
 * **A dep nothing can practise does not gate.** Section 1.3's rule is "every dep
 * at nodeMastery >= 0.80", which assumes every node has a drill. Slice 5 shipped
 * with three of the four V1 keyboard-theory nodes behind `kt-geography`, whose
 * drill did not exist yet, so the literal rule left the day-one queue empty with
 * 72 practisable triads unreachable behind it. That was the exact failure the
 * tree's own `v1Patch` was written to fix ("every V1 node sat behind a non-V1
 * root gate, so the unlock rule left the day-one queue empty"), arriving again
 * for a different reason.
 *
 * The bypass named the deps it skipped in `bypassedDeps`, which the progress
 * screen shows, and it was written to expire by itself. **Slice 6 expired it**:
 * `note-find` gives `kt-geography` items, so it gates like any other dep and the
 * first thing a new install practises is the keyboard-geography deck. The rule
 * stays because the tree has 53 nodes and 4 drills, and because the shape of the
 * failure it prevents does not go away until the last one is built.
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
