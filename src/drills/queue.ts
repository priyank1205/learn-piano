/**
 * Item order inside one session.
 *
 * This is NOT the scheduler. Spaced repetition operates on `dueAt`, `ease` and
 * `intervalDays` across sessions (session-generator.md sections 1 and 4), and
 * all of that needs the store, which is the next slice. What a deck needs
 * before any of it exists is an order that is not "random with replacement",
 * because random with replacement serves the same item three times in a row and
 * leaves others untouched for a hundred reps.
 *
 * So: a shuffled cycle. Every item in the deck is served once before any is
 * served twice, reshuffled each pass. That is a stronger variety guarantee than
 * section 4's "at most twice per session", which governs sampling from a due
 * pool of hundreds and does not transfer to a 36-item deck being drilled
 * directly.
 *
 * The one scheduling rule that does apply now is the in-session half of the
 * `again` learning step (section 2): a missed item comes back after 3 to 6
 * other items, in this same session. Getting it wrong and then not seeing it
 * again for twenty minutes is how a miss becomes a habit.
 */

import type { DrillItem, Rng } from './types.ts';

export interface QueueOptions {
  rng?: Rng;
  /** Inclusive bounds on how many other items follow a miss before it returns. */
  requeueGap?: readonly [number, number];
}

/** Fisher-Yates. Returns a new array; the deck itself is never reordered. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export class ItemQueue {
  readonly deck: readonly DrillItem[];

  private upcoming: DrillItem[] = [];
  private lastServed: DrillItem | null = null;
  private readonly rng: Rng;
  private readonly requeueGap: readonly [number, number];

  constructor(deck: readonly DrillItem[], opts: QueueOptions = {}) {
    this.deck = deck;
    this.rng = opts.rng ?? Math.random;
    this.requeueGap = opts.requeueGap ?? [3, 6];
    this.refill();
  }

  /** Items waiting in the current pass. For the "N left in this pass" readout. */
  get remaining(): number {
    return this.upcoming.length;
  }

  next(): DrillItem | null {
    if (this.deck.length === 0) return null;
    if (this.upcoming.length === 0) this.refill();
    const item = this.upcoming.shift() ?? null;
    this.lastServed = item;
    return item;
  }

  /**
   * Put a missed item back, 3 to 6 items further on. If the pass is shorter
   * than that it lands at the end of the pass and the next reshuffle keeps it
   * ahead of a full cycle anyway, which is the intent: soon, not immediately.
   */
  requeue(item: DrillItem): void {
    const [lo, hi] = this.requeueGap;
    const gap = lo + Math.floor(this.rng() * (hi - lo + 1));
    const at = Math.min(gap, this.upcoming.length);
    this.upcoming.splice(at, 0, item);
  }

  private refill(): void {
    const pass = shuffle(this.deck, this.rng);
    // A reshuffle must not hand back the item that just finished: the deck
    // boundary is invisible to the user, and the same chord twice in a row
    // reads as the app being broken.
    if (
      pass.length > 1 &&
      this.lastServed &&
      pass[0]!.itemId === this.lastServed.itemId
    ) {
      const swapWith = 1 + Math.floor(this.rng() * (pass.length - 1));
      const head = pass[0]!;
      pass[0] = pass[swapWith]!;
      pass[swapWith] = head;
    }
    this.upcoming = pass;
  }
}
