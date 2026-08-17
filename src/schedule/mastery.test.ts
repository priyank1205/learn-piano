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
} from './mastery.ts';
import { newItemState } from './srs.ts';
import type { ItemState } from '../store/types.ts';
import { itemsForNode } from '../drills/registry.ts';
import { deckFluencyOf, nodeById } from '../tree.ts';

const NOW = new Date(2026, 7, 12, 10, 0, 0).getTime();
const MAJ = 'kt-inv-maj-triads';

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

  it('says plainly that a threshold type it cannot measure is unmeasured', () => {
    // pr-legato-5finger is a `legato` threshold and the legato grader does not
    // exist. Reporting 0% would read as failing rather than as unbuilt.
    const p = nodeProgress(new Map()).get('pr-legato-5finger')!;
    expect(p.measurable).toBe(false);
    expect(p.complete).toBe(false);
  });
});

describe('unlocking', () => {
  it('bypasses a dep that nothing can practise yet, and names it', () => {
    // kt-triads-root depends on kt-geography, whose drill is slice 6. Under the
    // literal rule the whole V1 keyboard-theory chain is unreachable and the
    // day-one queue is empty, with 72 practisable triads sitting behind it.
    const p = nodeProgress(new Map()).get('kt-triads-root')!;
    expect(p.bypassedDeps).toContain('kt-geography');
    expect(p.blockedBy).toEqual([]);
    expect(p.lifecycle).not.toBe('locked');
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
    expect(active.some((p) => p.nodeId === 'kt-triads-root')).toBe(true);
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
    const { active } = deriveProgress(new Map(), {
      completedAt: { 'kt-triads-root': NOW },
    });
    expect(active.some((p) => p.nodeId === 'kt-triads-root')).toBe(false);
  });
});
