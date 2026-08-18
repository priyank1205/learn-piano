/**
 * Tests for the derived layer (session-generator.md sections 1.2, 1.3 and 3).
 *
 * The unlock tests are the ones that matter most, and not because unlocking is
 * subtle. The tree's own `v1Patch` records that the first version of the V1 set
 * shipped with an empty day-one queue, because every V1 node sat behind a gate
 * nothing could open. That is a whole-app failure with no error message
 * anywhere: the scheduler simply has nothing to say. These pin the two rules
 * that prevent it recurring.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_LEARNING_PER_TRACK,
  MAX_LEARNING_TOTAL,
  UNLOCK_MASTERY,
  activeNodes,
  deriveProgress,
  descendantCount,
  itemMastered,
  nodeProgress,
  nodeWeight,
  repWindow,
} from './mastery.ts';
import { newItemState } from './srs.ts';
import type { ItemState, RepRow } from '../store/types.ts';
import { itemsForNode } from '../drills/registry.ts';
import { deckFluencyOf, earDeckOf, nodeById, timedRunOf } from '../tree.ts';

const NOW = new Date(2026, 7, 12, 10, 0, 0).getTime();
const MAJ = 'kt-inv-maj-triads';
const GEO = 'kt-geography';
const PULSE = 'pr-pulse-sync';
const EAR = 'ear-intervals-1';

const correct = (ts: number) => ({
  ts,
  rating: 'easy' as const,
  correct: true,
  latencyMs: 900,
});

function mastered(itemId: string, nodeIds: string[]): ItemState {
  return {
    ...newItemState(itemId, nodeIds, NOW),
    status: 'review',
    step: 2,
    reps: 6,
    accEMA: 1,
    latEMA: 900,
    history: [correct(NOW - 3), correct(NOW - 2), correct(NOW - 1)],
  };
}

/** Every item of a node, at the state given. */
function fill(nodeId: string, make: (itemId: string, nodeIds: string[]) => ItemState) {
  return new Map(
    itemsForNode(nodeId).map((i) => [i.itemId, make(i.itemId, [...i.nodeIds])])
  );
}

describe('itemMastered', () => {
  const node = nodeById(MAJ)!;
  const base = mastered('x', [MAJ]);

  it('wants the last three reps correct, the accuracy, and the latency', () => {
    expect(itemMastered(base, node)).toBe(true);
  });

  it('rejects an item whose most recent rep was wrong', () => {
    const slipped = {
      ...base,
      history: [
        correct(NOW - 2),
        correct(NOW - 1),
        { ts: NOW, rating: 'again' as const, correct: false, latencyMs: null },
      ],
    };
    expect(itemMastered(slipped, node)).toBe(false);
  });

  it('rejects an item that is right but slow', () => {
    expect(itemMastered({ ...base, latEMA: 1500 }, node)).toBe(false);
  });

  it('rejects an item below the node accuracy the tree declares', () => {
    const threshold = deckFluencyOf(MAJ)!.accuracy;
    expect(itemMastered({ ...base, accEMA: threshold - 0.01 }, node)).toBe(false);
  });

  it('rejects three lucky reps under the minimum rep count', () => {
    expect(itemMastered({ ...base, reps: 2 }, node)).toBe(false);
  });

  it('rejects a suspended leech however good its numbers look', () => {
    expect(itemMastered({ ...base, status: 'suspended' }, node)).toBe(false);
  });

  it('needs a real latency observation, not the zero seed', () => {
    expect(itemMastered({ ...base, latEMA: 0 }, node)).toBe(false);
  });
});

describe('node mastery', () => {
  it('divides by the item count the curriculum declares, not by what is drilled', () => {
    // One mastered item out of 36 is 1/36, never 1/1.
    const items = itemsForNode(MAJ);
    const states = new Map([[items[0]!.itemId, mastered(items[0]!.itemId, [MAJ])]]);
    const p = nodeProgress(states).get(MAJ)!;
    expect(p.itemCount).toBe(nodeById(MAJ)!.itemCount);
    expect(p.mastered).toBe(1);
    expect(p.mastery).toBeCloseTo(1 / 36);
  });

  it('reaches 1 when every item is mastered', () => {
    const p = nodeProgress(fill(MAJ, mastered)).get(MAJ)!;
    expect(p.mastery).toBe(1);
    expect(p.complete).toBe(true);
  });

  it('flags decay on a node that was complete and has slipped', () => {
    const p = nodeProgress(new Map(), { completedAt: { [MAJ]: NOW } }).get(MAJ)!;
    expect(p.complete).toBe(true);
    expect(p.decayed).toBe(true);
    expect(nodeWeight(p)).toBe(1.3);
  });

  /**
   * Slice 6 asserted that `pr-legato-5finger` was unmeasurable, because its
   * threshold type is `legato` and the legato grader did not exist. Slice 7
   * built it, so the assertion inverts rather than being deleted: the list and
   * the grader registry are meant to move together, and this is the test that
   * notices when one moves without the other.
   */
  it('measures a legato node now that the legato grader exists', () => {
    const p = nodeProgress(new Map()).get('pr-legato-5finger')!;
    expect(p.measurable).toBe(true);
    expect(p.drillable).toBe(true);
    // Measurable is not complete: it still has to be practised, and it is locked
    // behind the pulse drill until that node is at 80%.
    expect(p.complete).toBe(false);
    expect(p.lifecycle).toBe('locked');
  });

  it('says plainly that a threshold type it cannot measure is unmeasured', () => {
    // pr-articulation is an `articulation` threshold and that grader does not
    // exist. Reporting 0% would read as failing rather than as unbuilt.
    const p = nodeProgress(new Map()).get('pr-articulation')!;
    expect(p.node.masteryThreshold.type).toBe('articulation');
    expect(p.measurable).toBe(false);
    expect(p.complete).toBe(false);
  });

  it('keeps the measurable list and the grader registry in step', () => {
    // The two lists only make sense together (`MEASURABLE_THRESHOLDS`): a
    // threshold type nothing can grade reports 0% where it means "not built".
    for (const p of nodeProgress(new Map()).values()) {
      if (!p.measurable) continue;
      expect(['deckFluency', 'timedRun', 'earDeck', 'legato']).toContain(
        p.node.masteryThreshold.type
      );
    }
  });
});

describe('unlocking', () => {
  /**
   * This test is the inverse of the one slice 5 shipped, and the inversion is
   * the point rather than a fix.
   *
   * Slice 5 asserted that `kt-triads-root` was NOT gated by `kt-geography`,
   * because nothing could practise geography and the literal unlock rule left
   * the day-one queue empty behind it. The bypass was written to expire on its
   * own the moment the missing drill landed. Slice 6 landed it, so the gate is
   * real: geography is now the first thing a new install practises, and the
   * triads open behind it at 80%.
   */
  it('gates behind a dep as soon as something can practise it', () => {
    const p = nodeProgress(new Map()).get('kt-triads-root')!;
    expect(itemsForNode('kt-geography').length).toBeGreaterThan(0);
    expect(p.bypassedDeps).toEqual([]);
    expect(p.blockedBy).toContain('kt-geography');
    expect(p.lifecycle).toBe('locked');
  });

  it('still bypasses a dep with no drill, and names it', () => {
    // The rule itself has not gone anywhere: 53 nodes, four drills. Any node
    // with an undrillable dep still shows which one is being skipped.
    const bypassing = [...nodeProgress(new Map()).values()].find(
      (p) => p.bypassedDeps.length > 0
    );
    expect(bypassing).toBeDefined();
    for (const dep of bypassing!.bypassedDeps) {
      expect(itemsForNode(dep)).toHaveLength(0);
    }
  });

  it('opens the geography gate at 80%, which puts the triads in play', () => {
    const need = Math.ceil(UNLOCK_MASTERY * Number(nodeById('kt-geography')!.itemCount));
    const states = new Map(
      itemsForNode('kt-geography')
        .slice(0, need)
        .map((i) => [i.itemId, mastered(i.itemId, [...i.nodeIds])])
    );
    const { progress, active } = deriveProgress(states);
    expect(progress.get('kt-triads-root')!.blockedBy).toEqual([]);
    expect(active.some((p) => p.nodeId === 'kt-triads-root')).toBe(true);
  });

  it('still locks behind a dep that can be practised and has not been', () => {
    // kt-inv-maj-triads depends on kt-triads-root, which the inversion trainer
    // does drill. That gate is real and stays shut.
    const p = nodeProgress(new Map()).get(MAJ)!;
    expect(p.blockedBy).toContain('kt-triads-root');
    expect(p.lifecycle).toBe('locked');
  });

  it('opens that gate at 80%, not at 100%', () => {
    const items = itemsForNode('kt-triads-root');
    const need = Math.ceil(
      UNLOCK_MASTERY * Number(nodeById('kt-triads-root')!.itemCount)
    );
    const states = new Map(
      items.slice(0, need).map((i) => [i.itemId, mastered(i.itemId, [...i.nodeIds])])
    );
    const progress = nodeProgress(states);
    expect(progress.get('kt-triads-root')!.mastery).toBeGreaterThanOrEqual(
      UNLOCK_MASTERY
    );
    expect(progress.get(MAJ)!.blockedBy).toEqual([]);
  });

  it('locks a node whose `requires` is unsatisfied', () => {
    const pedal = [...nodeProgress(new Map()).values()].find((p) =>
      p.node.requires.includes('pedal')
    );
    expect(pedal?.missingRequires).toEqual(['pedal']);
    expect(pedal?.lifecycle).toBe('locked');
  });
});

describe('the active set', () => {
  it('caps at two per track and five overall', () => {
    const active = activeNodes(nodeProgress(new Map()));
    expect(active.length).toBeLessThanOrEqual(MAX_LEARNING_TOTAL);
    const perTrack = new Map<string, number>();
    for (const p of active) perTrack.set(p.track, (perTrack.get(p.track) ?? 0) + 1);
    for (const n of perTrack.values())
      expect(n).toBeLessThanOrEqual(MAX_LEARNING_PER_TRACK);
  });

  it('holds only nodes that can actually be practised and measured', () => {
    for (const p of activeNodes(nodeProgress(new Map()))) {
      expect(p.drillable).toBe(true);
      expect(p.measurable).toBe(true);
      expect(itemsForNode(p.nodeId).length).toBeGreaterThan(0);
    }
  });

  it('is not empty on a first run, which is the whole point', () => {
    const { active } = deriveProgress(new Map());
    expect(active.length).toBeGreaterThan(0);
    // The three root gates, one per track. Everything else in V1 sits behind
    // one of them, so these are what a new install is offered on day one.
    expect(active.map((p) => p.nodeId).sort()).toEqual([
      'ear-intervals-1',
      'kt-geography',
      'pr-pulse-sync',
    ]);
  });

  it('spans every track once each track has a drill', () => {
    const { active } = deriveProgress(new Map());
    expect(new Set(active.map((p) => p.track)).size).toBe(3);
  });

  it('marks what it chose as learning, which is what weights it at 1.5', () => {
    const { progress, active } = deriveProgress(new Map());
    expect(active[0]!.lifecycle).toBe('learning');
    expect(nodeWeight(progress.get(active[0]!.nodeId))).toBe(1.5);
  });

  it('prefers a node that unlocks more of the tree', () => {
    // kt-triads-root has descendants; a leaf does not. Used as the tiebreak
    // after isV1 in section 3's promotion order.
    expect(descendantCount('kt-triads-root')).toBeGreaterThan(0);
    expect(descendantCount('kt-triads-root')).toBeGreaterThan(descendantCount(MAJ));
  });

  it('drops a node from the set once it is complete', () => {
    expect(deriveProgress(new Map()).active.some((p) => p.nodeId === GEO)).toBe(true);
    const { active } = deriveProgress(new Map(), { completedAt: { [GEO]: NOW } });
    expect(active.some((p) => p.nodeId === GEO)).toBe(false);
  });
});

/**
 * The two threshold shapes slice 6 taught this file to read. Both needed a
 * reading rather than a transcription, and both readings are here rather than
 * only in a comment.
 */
describe('timedRun mastery', () => {
  const node = nodeById(PULSE)!;
  const threshold = timedRunOf(PULSE)!;

  const passes = (n: number): ItemState => ({
    ...newItemState('x', [PULSE], NOW),
    status: 'review',
    reps: n,
    accEMA: n === 0 ? 0 : 1,
    history: Array.from({ length: n }, (_, i) => ({
      ts: NOW + i,
      rating: 'good' as const,
      correct: true,
      latencyMs: null,
    })),
  });

  it('wants cleanPasses consecutive clean passes, from the tree', () => {
    expect(threshold.cleanPasses).toBeGreaterThan(0);
    expect(itemMastered(passes(threshold.cleanPasses), node)).toBe(true);
    expect(itemMastered(passes(threshold.cleanPasses - 1), node)).toBe(false);
  });

  it('is broken by the most recent rep, not by the average', () => {
    const slipped = passes(threshold.cleanPasses);
    slipped.history[slipped.history.length - 1] = {
      ts: NOW,
      rating: 'hard',
      correct: false,
      latencyMs: null,
    };
    expect(itemMastered(slipped, node)).toBe(false);
  });

  /**
   * `noteAccuracy: 1.0` is a per-rep rule the grader has already applied. Read
   * as an accEMA threshold it would be unreachable, because an EMA that has seen
   * one miss never returns to 1, so a single early mistake would lock the node
   * out of completion forever.
   */
  it('does not read its per-rep noteAccuracy as an EMA threshold', () => {
    expect(threshold.noteAccuracy).toBe(1);
    const recovered = { ...passes(threshold.cleanPasses), accEMA: 0.86 };
    expect(itemMastered(recovered, node)).toBe(true);
  });

  it('completes only when every item has its clean passes', () => {
    const all = fill(PULSE, (itemId, nodeIds) => ({
      ...passes(threshold.cleanPasses),
      itemId,
      nodeIds,
    }));
    expect(nodeProgress(all).get(PULSE)!.complete).toBe(true);

    const [first] = [...all.keys()];
    all.set(first!, { ...passes(1), itemId: first!, nodeIds: [PULSE] });
    expect(nodeProgress(all).get(PULSE)!.complete).toBe(false);
  });
});

describe('earDeck mastery', () => {
  const threshold = earDeckOf(EAR)!;

  const earRep = (i: number, correct: boolean, latencyMs: number | null): RepRow => ({
    id: `r${i}`,
    ts: NOW + i,
    sessionId: 's',
    itemId: `item${i % 6}`,
    drillId: 'ear-id',
    nodeIds: [EAR],
    rating: correct ? 'good' : 'again',
    correct,
    latencyMs,
    timingStats: null,
  });

  const windowOf = (reps: RepRow[]) => repWindow(EAR, reps, threshold.windowItems);

  it('reads the last windowItems reps of that node and nothing else', () => {
    const reps = [
      ...Array.from({ length: 60 }, (_, i) => earRep(i, false, null)),
      ...Array.from({ length: threshold.windowItems }, (_, i) =>
        earRep(100 + i, true, 1500)
      ),
    ];
    const w = windowOf(reps);
    expect(w.reps).toBe(threshold.windowItems);
    expect(w.accuracy).toBe(1);
    expect(w.medianMs).toBe(1500);
  });

  it('ignores reps belonging to other nodes', () => {
    const mine = earRep(1, true, 1000);
    const theirs = { ...earRep(2, false, null), nodeIds: ['kt-geography'] };
    expect(windowOf([mine, theirs]).reps).toBe(1);
  });

  /** A fast wrong answer is not evidence of a fast right one. */
  it('takes the median over correct reps only', () => {
    const w = windowOf([earRep(1, true, 2000), earRep(2, false, 200)]);
    expect(w.medianMs).toBe(2000);
    expect(w.accuracy).toBe(0.5);
  });

  it('completes on a full window at the accuracy and under the median', () => {
    const full = (latencyMs: number, wrong = 0) =>
      Array.from({ length: threshold.windowItems }, (_, i) =>
        earRep(i, i >= wrong, latencyMs)
      );
    const states = fill(EAR, mastered);
    const complete = (reps: RepRow[]) =>
      nodeProgress(states, { reps }).get(EAR)!.complete;

    expect(complete(full(1500))).toBe(true);
    // Same answers, slower than the deck's own response target.
    expect(complete(full(threshold.medianResponseMsMax + 200))).toBe(false);
    // Same speed, one miss too many.
    const misses = Math.ceil(threshold.windowItems * (1 - threshold.accuracy)) + 1;
    expect(complete(full(1500, misses))).toBe(false);
  });

  it('cannot complete on a window that is not full yet', () => {
    const states = fill(EAR, mastered);
    const short = Array.from({ length: threshold.windowItems - 1 }, (_, i) =>
      earRep(i, true, 900)
    );
    expect(nodeProgress(states, { reps: short }).get(EAR)!.complete).toBe(false);
  });

  /**
   * The ear deck answers after a sound, so its latency target is its own 2500ms
   * and not the 1200ms keyboard-recall band.
   */
  it('measures an item against the deck response target, not the automatic band', () => {
    const node = nodeById(EAR)!;
    const slowish = { ...mastered('x', [EAR]), latEMA: 2000 };
    expect(slowish.latEMA).toBeGreaterThan(1200);
    expect(itemMastered(slowish, node)).toBe(true);
    expect(
      itemMastered({ ...slowish, latEMA: threshold.medianResponseMsMax + 1 }, node)
    ).toBe(false);
  });
});
