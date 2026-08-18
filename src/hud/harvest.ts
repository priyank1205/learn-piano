/**
 * The free-play harvest (session-generator.md section 8).
 *
 * "The chord HUD has a passive mode: no prompts, he plays charts exactly as he
 * does today. The HUD logs `(detected chord, timestamp)` pairs. Chords whose
 * *change latency* ... is consistently slow get their corresponding items'
 * `latEMA` nudged (alpha 0.1). His existing habit becomes the scheduler's
 * reconnaissance - the app earns value from him **before** demanding anything."
 *
 * That paragraph makes three promises, and the code is split so that each one
 * has an owner:
 *
 *  - **"consistently"** is here. One slow chord is a hand that was somewhere
 *    else; the same chord slow three times is a fact about the chord. So
 *    observations accumulate per item and nothing is reported until there are
 *    enough of them, and what is reported is their median rather than the latest
 *    one, so a single fumble cannot carry a whole item.
 *  - **"alpha 0.1, slow only"** is `schedule/srs.ts`'s `nudgeLatency`.
 *  - **"never scheduling"** is `select.ts`'s `inSchedule`: a harvested row has a
 *    `latEMA` and no reps, and nothing serves it.
 *
 * Observations live for as long as the HUD is open and are not persisted. They
 * are evidence for a nudge, not a record of anything, and the nudge itself is
 * what survives.
 */

import { median } from '../stats.ts';

/**
 * How many times a chord has to be slow before "consistently" is satisfied.
 *
 * Three, which is the same number section 1.2 uses for "last N reps all
 * correct". Low enough that a short session of playing produces nudges at all,
 * high enough that one interruption mid-chart does not.
 */
export const HARVEST_MIN_OBSERVATIONS = 3;

export interface HarvestNudge {
  itemId: string;
  /** The median of everything seen for this item, which is what gets applied. */
  medianMs: number;
  observations: number;
}

export interface HarvestRow extends HarvestNudge {
  label: string;
  latestMs: number;
}

/**
 * Accumulates change latencies per item and says when one is worth acting on.
 *
 * Pure and clock-free: every input is an argument, so a session of playing can
 * be replayed in a test as a list of numbers.
 */
export class Harvest {
  private readonly observations = new Map<string, number[]>();
  private readonly labels = new Map<string, string>();

  /**
   * Record one change latency. Returns a nudge once the item has been seen
   * enough times to call the result consistent, and null before that.
   */
  observe(itemId: string, label: string, latencyMs: number): HarvestNudge | null {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return null;

    const seen = this.observations.get(itemId);
    if (seen) seen.push(latencyMs);
    else this.observations.set(itemId, [latencyMs]);
    this.labels.set(itemId, label);

    const all = this.observations.get(itemId)!;
    if (all.length < HARVEST_MIN_OBSERVATIONS) return null;
    return { itemId, medianMs: median(all), observations: all.length };
  }

  /** Everything seen this session, slowest first. For the screen. */
  rows(): HarvestRow[] {
    const out: HarvestRow[] = [];
    for (const [itemId, all] of this.observations) {
      out.push({
        itemId,
        label: this.labels.get(itemId) ?? itemId,
        medianMs: median(all),
        latestMs: all[all.length - 1]!,
        observations: all.length,
      });
    }
    return out.sort((a, b) => b.medianMs - a.medianMs);
  }

  get size(): number {
    return this.observations.size;
  }

  reset(): void {
    this.observations.clear();
    this.labels.clear();
  }
}
