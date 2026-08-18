/**
 * The drill registry: templates in, items out.
 *
 * Pools are built once at module load. 72 items is nothing to compute, and
 * building them eagerly means every item id exists before anything asks for
 * one, which is what lets a stored rep from a previous session be resolved back
 * to the item that produced it.
 *
 * `drillFor` throws on an unknown id rather than returning undefined, for the
 * same reason `graderFor` does: a drill that silently does not exist is a
 * screen that renders nothing and a rep that goes nowhere.
 *
 * Separate from `index.ts` so that `practice.ts` can import the registry
 * without importing the barrel that exports `practice.ts`. A cycle through a
 * module that builds state at load time is the kind of thing that works until
 * the day an import order changes.
 */

import { INVERSION_TRAINER_ID, inversionTrainer } from './inversionTrainer.ts';
import { NOTE_FIND_ID, noteFind } from './noteFind.ts';
import { RHYTHM_TAP_ID, rhythmTap } from './rhythmTap.ts';
import { EAR_ID, earId } from './earId.ts';
import { LEGATO_ID, legatoLine } from './legato.ts';
import { buildItems } from './pool.ts';
import type { DrillItem, DrillParams, DrillTemplate } from './types.ts';

/**
 * A template with its params erased, which is what a registry and a generic
 * screen can hold. The cast at registration is the price of templates being
 * strongly typed in their own params: a `DrillTemplate<InversionParams>` only
 * ever receives params from its own pool, so erasing them at this boundary
 * loses nothing that was being checked.
 */
export type AnyDrillTemplate = DrillTemplate<DrillParams>;

/**
 * Registration order is the order decks are offered in, so it follows the tree:
 * the gate first, then what it opens.
 */
export const DRILLS: Record<string, AnyDrillTemplate> = {
  [NOTE_FIND_ID]: noteFind as unknown as AnyDrillTemplate,
  [INVERSION_TRAINER_ID]: inversionTrainer as unknown as AnyDrillTemplate,
  [RHYTHM_TAP_ID]: rhythmTap as unknown as AnyDrillTemplate,
  [LEGATO_ID]: legatoLine as unknown as AnyDrillTemplate,
  [EAR_ID]: earId as unknown as AnyDrillTemplate,
};

export function drillFor(id: string): AnyDrillTemplate {
  const template = DRILLS[id];
  if (!template) {
    throw new Error(
      `No drill template '${id}'. Registered: ${Object.keys(DRILLS).join(', ')}.`
    );
  }
  return template;
}

const POOLS = new Map<string, readonly DrillItem[]>(
  Object.entries(DRILLS).map(([id, template]) => [id, buildItems(template)])
);

const BY_ITEM_ID = new Map<string, DrillItem>();
for (const items of POOLS.values()) {
  for (const item of items) BY_ITEM_ID.set(item.itemId, item);
}

export function itemsFor(templateId: string): readonly DrillItem[] {
  const items = POOLS.get(templateId);
  // Not registered at all: throw with the registry listed, same as drillFor.
  if (!items) drillFor(templateId);
  return items ?? [];
}

/** Every item any drill contributes to a node. The deck for that node. */
export function itemsForNode(nodeId: string): DrillItem[] {
  const out: DrillItem[] = [];
  for (const items of POOLS.values()) {
    for (const item of items) if (item.nodeIds.includes(nodeId)) out.push(item);
  }
  return out;
}

/**
 * The deck for a set of nodes, deduplicated. Selecting an inversion node and
 * the root-position node it overlaps must not put root-position triads in the
 * deck twice.
 */
export function itemsForNodes(nodeIds: readonly string[]): DrillItem[] {
  const seen = new Map<string, DrillItem>();
  for (const nodeId of nodeIds) {
    for (const item of itemsForNode(nodeId)) seen.set(item.itemId, item);
  }
  return [...seen.values()];
}

/** Resolve a stored rep back to its item. Undefined once a pool changes shape. */
export function itemById(itemId: string): DrillItem | undefined {
  return BY_ITEM_ID.get(itemId);
}

export function templateForItem(item: DrillItem): AnyDrillTemplate {
  return drillFor(item.templateId);
}

/** Every node the registered drills can exercise, in registration order. */
export function drillableNodeIds(): string[] {
  const out = new Set<string>();
  for (const template of Object.values(DRILLS)) {
    for (const id of template.nodeIds) out.add(id);
  }
  return [...out];
}
