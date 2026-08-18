/**
 * Tests for the drill schema, the item pool and item identity.
 *
 * Two of these are not really behaviour tests.
 *
 * The pinned hashes exist because an item id is the primary key of practice
 * history. Nothing in the app notices when an id changes: the deck still works,
 * the grader still grades, and every rep ever recorded against the old id is
 * simply never found again. A failing expectation here is the only warning that
 * will ever be given.
 *
 * The item counts are checked against `docs/skill-tree.json` rather than
 * against literals, because the tree is the curriculum and this code is one
 * reading of it. If they disagree, one of the two is wrong and the test cannot
 * say which, which is exactly the conversation that should happen.
 */

import { describe, expect, it } from 'vitest';
import tree from '../../docs/skill-tree.json';
import { canonicalParams, itemIdOf, stableHash } from './hash.ts';
import { cartesian } from './pool.ts';
import { INVERSION_TRAINER_ID, inversionTrainer } from './inversionTrainer.ts';
import { DRILLS, drillFor, itemsFor, itemsForNode, itemsForNodes } from './registry.ts';
import { instantiate } from './types.ts';
import type { DrillItem } from './types.ts';
import type { InversionParams } from './inversionTrainer.ts';
import { Note } from 'tonal';
import { pitchClassOf } from '../theory.ts';

const itemCountOf = (id: string): number => {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No node ${id} in the tree`);
  return node.itemCount as number;
};

describe('stable ids', () => {
  it('does not depend on the order params were written in', () => {
    const a = itemIdOf('d', { rootPc: 1, quality: 'maj', inversion: 2 });
    const b = itemIdOf('d', { inversion: 2, quality: 'maj', rootPc: 1 });
    expect(a).toBe(b);
  });

  it('distinguishes a numeric value from the same digits as a string', () => {
    expect(canonicalParams({ x: 1 })).not.toBe(canonicalParams({ x: '1' }));
    expect(itemIdOf('d', { x: 1 })).not.toBe(itemIdOf('d', { x: '1' }));
  });

  it('distinguishes templates that share a param set', () => {
    expect(itemIdOf('a', { x: 1 })).not.toBe(itemIdOf('b', { x: 1 }));
  });

  it('is a fixed-width base-36 string', () => {
    expect(stableHash('anything')).toMatch(/^[0-9a-z]{14}$/);
  });

  /**
   * Pinned. Changing these strings orphans every rep already logged against
   * them, so a failure here needs a migration, not a new expectation.
   */
  it('assigns the ids that history is keyed on', () => {
    const id = (rootPc: number, quality: string, inversion: number) =>
      itemIdOf(INVERSION_TRAINER_ID, { rootPc, quality, inversion });
    // C, Db/F, F#m/C#.
    expect(id(0, 'maj', 0)).toBe('0g7jqcu0hk02ko');
    expect(id(1, 'maj', 1)).toBe('10v2gng0nv1dae');
    expect(id(6, 'min', 2)).toBe('1kocb1209chsqo');
  });

  it('gives every item in every registered pool a distinct id', () => {
    const seen = new Set<string>();
    for (const id of Object.keys(DRILLS)) {
      for (const item of itemsFor(id)) seen.add(item.itemId);
    }
    const total = Object.keys(DRILLS).reduce((n, id) => n + itemsFor(id).length, 0);
    expect(seen.size).toBe(total);
  });
});

describe('cartesian', () => {
  it('is the product of the declared spaces', () => {
    const rows = cartesian({ a: [1, 2, 3], b: ['x', 'y'] });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ a: 1, b: 'x' });
    // Last declared param varies fastest.
    expect(rows[1]).toEqual({ a: 1, b: 'y' });
  });

  it('is empty when any dimension is', () => {
    expect(cartesian({ a: [1, 2], b: [] })).toHaveLength(0);
  });
});

/**
 * The registry erases a template's param type, since it holds every drill in
 * one map. These tests reach past that to check the inversion trainer's own
 * params, which is the one place that knows they are safe.
 */
const inversionItems = itemsFor(
  INVERSION_TRAINER_ID
) as readonly DrillItem<InversionParams>[];

describe('the inversion trainer pool', () => {
  const items = inversionItems;

  it('is twelve roots by two qualities by three inversions', () => {
    expect(items).toHaveLength(72);
  });

  /**
   * The tree declares 24 + 36 + 36 = 96 items over 72 distinct triads, which is
   * only consistent if root-position triads belong to two nodes at once. This
   * is the assertion that says so out loud.
   */
  it('reproduces the item count each node declares', () => {
    expect(itemsForNode('kt-triads-root')).toHaveLength(itemCountOf('kt-triads-root'));
    expect(itemsForNode('kt-inv-maj-triads')).toHaveLength(
      itemCountOf('kt-inv-maj-triads')
    );
    expect(itemsForNode('kt-inv-min-triads')).toHaveLength(
      itemCountOf('kt-inv-min-triads')
    );
  });

  it('counts a root-position triad toward both its nodes', () => {
    const cMajorRoot = items.find(
      (i) =>
        i.params.rootPc === 0 && i.params.quality === 'maj' && i.params.inversion === 0
    );
    expect(cMajorRoot?.nodeIds).toEqual(['kt-triads-root', 'kt-inv-maj-triads']);
  });

  it('deduplicates a deck built from overlapping nodes', () => {
    const both = itemsForNodes(['kt-triads-root', 'kt-inv-maj-triads']);
    // 36 major items plus the 12 minor root-position ones.
    expect(both).toHaveLength(48);
    expect(new Set(both.map((i) => i.itemId)).size).toBe(48);
  });

  it('claims only nodes it declares', () => {
    for (const item of items) {
      expect(item.nodeIds.length).toBeGreaterThan(0);
      for (const nodeId of item.nodeIds) {
        expect(inversionTrainer.nodeIds).toContain(nodeId);
      }
    }
  });

  it('names every node it claims in the tree', () => {
    for (const nodeId of inversionTrainer.nodeIds) {
      expect(tree.nodes.some((n) => n.id === nodeId)).toBe(true);
    }
  });
});

describe('what the pool prompts and expects', () => {
  const items = inversionItems;

  it('expects three notes with the inversion bass underneath, for all 72', () => {
    for (const item of items) {
      const expected = inversionTrainer.buildExpected(item.params);
      const event = expected.events[0]!;
      expect(expected.events).toHaveLength(1);
      expect(event.pitches).toHaveLength(3);
      // Ascending: the reference voicing is a closest-position stack.
      expect([...event.pitches].sort((a, b) => a - b)).toEqual(event.pitches);
      expect(event.bassPc).toBe(pitchClassOf(event.pitches[0]!));
      // Untimed: no grid, so no beat.
      expect(event.atBeat).toBeUndefined();
      expect(expected.tempoBpm).toBeUndefined();
    }
  });

  /**
   * The prompt, the revealed answer, the audition chord and the graded pitches
   * are four separate expressions of one chord. `theory.test.ts` already proves
   * the symbol parses back to the right notes; what this proves is that the
   * template wired those four to the same params, in the same order. A reveal
   * that names the root-position notes under a first-inversion symbol would
   * teach the wrong thing while grading correctly.
   */
  it('reveals and sounds exactly what it grades, for all 72', () => {
    for (const item of items) {
      const view = inversionTrainer.view(item.params);
      const event = inversionTrainer.buildExpected(item.params).events[0]!;

      expect(view.audition).toEqual(event.pitches);

      const answerPcs = view.answer.split(' ').map((name) => Note.chroma(name));
      expect(answerPcs).toEqual(event.pitches.map(pitchClassOf));
      // Bass first, both in the reveal and in what inversionStrict checks.
      expect(answerPcs[0]).toBe(event.bassPc);
    }
  });

  it('places the reference voicing inside the 61-key window', () => {
    for (const item of items) {
      for (const pitch of inversionTrainer.view(item.params).audition) {
        // The instrument is MIDI 36 to 96 (skill-tree.json meta.instrument).
        expect(pitch).toBeGreaterThanOrEqual(36);
        expect(pitch).toBeLessThanOrEqual(96);
      }
    }
  });

  it('labels an item the way the prompt reads', () => {
    const item = items.find(
      (i) =>
        i.params.rootPc === 1 && i.params.quality === 'maj' && i.params.inversion === 1
    )!;
    expect(item.label).toBe('Db/F');
    expect(inversionTrainer.view(item.params).primary).toBe('Db/F');
    expect(inversionTrainer.view(item.params).sharps).toBe(false);
  });

  it('spells minor roots without double accidentals', () => {
    const gbMinor = items.find(
      (i) =>
        i.params.rootPc === 6 && i.params.quality === 'min' && i.params.inversion === 0
    )!;
    // F# minor, not Gb minor, whose third would be Bbb.
    expect(gbMinor.label).toBe('F#m');
  });
});

describe('instantiate', () => {
  const item = itemsFor(INVERSION_TRAINER_ID)[0]!;

  it('carries the item id, the nodes and the grader into the rep', () => {
    const prompt = instantiate(inversionTrainer, item);
    expect(prompt.itemId).toBe(item.itemId);
    expect(prompt.drillId).toBe(INVERSION_TRAINER_ID);
    expect(prompt.nodeIds).toEqual(item.nodeIds);
    expect(prompt.grading.graderId).toBe('set');
    expect(prompt.constraints.octaveEquivalent).toBe(true);
    expect(prompt.constraints.inversionStrict).toBe(true);
  });

  it('applies a tolerance override without mutating the template', () => {
    const prompt = instantiate(inversionTrainer, item, { chordClusterMs: 200 });
    expect(prompt.grading.tolerances?.chordClusterMs).toBe(200);
    expect(inversionTrainer.grading.tolerances).toBeUndefined();
  });
});

describe('the registry', () => {
  it('names what it has when asked for something it does not', () => {
    // `legato-line` was the example here until slice 7 built it. Any id that is
    // genuinely not registered does: what is being tested is that the failure
    // names the registry rather than returning undefined.
    expect(() => drillFor('pedal-sync')).toThrow(/inversion-trainer/);
    expect(() => drillFor('pedal-sync')).toThrow(/legato-line/);
  });
});
