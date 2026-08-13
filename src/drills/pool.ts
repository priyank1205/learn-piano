/**
 * The item pool: the cartesian product of a template's `paramSpace`
 * (architecture.md section 2, "The cartesian product IS the item pool").
 *
 * Taking that literally is a constraint on how param spaces are declared, not a
 * detail of this file. A space whose combinations are not all valid would need
 * a filter here, and a filter is the seam through which per-drill special cases
 * get into the engine. The inversion trainer keeps the product whole by taking
 * its root as a pitch class and leaving spelling to the prompt, rather than
 * listing root names that are only valid for one quality.
 */

import type { DrillItem, DrillParams, DrillTemplate, ParamSpace } from './types.ts';
import { makeItem } from './types.ts';

/**
 * Every combination, with the last declared param varying fastest. The order is
 * stable but carries no meaning: selection shuffles, and item identity comes
 * from the params rather than from a position in this array.
 */
export function cartesian<P extends DrillParams>(space: ParamSpace<P>): P[] {
  const keys = Object.keys(space);
  let rows: Record<string, unknown>[] = [{}];

  for (const key of keys) {
    const values = (space as Record<string, readonly unknown[]>)[key] ?? [];
    const next: Record<string, unknown>[] = [];
    for (const row of rows) {
      for (const value of values) next.push({ ...row, [key]: value });
    }
    rows = next;
  }

  return rows as P[];
}

export function buildItems<P extends DrillParams>(
  template: DrillTemplate<P>
): DrillItem<P>[] {
  return cartesian(template.paramSpace).map((params) => makeItem(template, params));
}
