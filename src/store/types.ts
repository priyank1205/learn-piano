/**
 * The persisted shapes (architecture.md section 8) and the schema version they
 * are written under.
 *
 * Two rules govern everything in this file.
 *
 * **Authoritative vs reconstructable.** `itemState` and `repLog` are
 * authoritative; node mastery, unlock state and every chart are derived and may
 * be thrown away at any time. That split is what makes a tolerance change
 * survivable: re-grade the raw MIDI, rewrite the derived layer, and nothing has
 * been lost. It also means `itemState` is recoverable in principle, because the
 * SM-2 update is a deterministic function of the rating sequence in `repLog`.
 * That is the answer to localForage having no cross-store transaction: a rep is
 * written before the item state it caused, so a crash between the two loses a
 * derived value, never the fact.
 *
 * **Ids are forever.** `itemId` is the primary key of practice history and is
 * pinned in `drills/pool.test.ts`. Nothing here may key on anything else.
 */

import type { NormalizedEvent } from '../midi.ts';
import type { TimingStats } from '../grade/index.ts';
import type { Track } from '../tree.ts';

/**
 * Bumped only when a stored shape changes incompatibly. `db.ts` refuses to
 * open a newer database than it understands rather than reading it as if the
 * fields meant what they used to.
 */
export const SCHEMA_VERSION = 1;

export type ItemStatus = 'new' | 'learning' | 'review' | 'suspended';

/** session-generator.md section 2. Correctness gates, latency grades. */
export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface RepHistoryEntry {
  ts: number;
  rating: Rating;
  correct: boolean;
  latencyMs: number | null;
}

/** How many reps `ItemState.history` keeps (session-generator.md section 1.1). */
export const HISTORY_LENGTH = 10;

/**
 * The unit spaced repetition operates on (session-generator.md section 1.1).
 *
 * Three additions to the spec's list, each because the spec's own rules cannot
 * be implemented without them:
 *
 *  - **`nodeIds`, plural.** Section 1.1 writes `nodeId`, but slice 4 established
 *    that an item belongs to several nodes at once (a root-position triad is
 *    claimed by both `kt-triads-root` and `kt-inv-maj-triads`). Stored rather
 *    than looked up so an item whose pool has since changed shape still knows
 *    what it was counting toward.
 *  - **`step`.** Section 2's learning steps are a two-position sequence
 *    (in-session re-queue, then next session). Which position an item is at is
 *    not derivable from `status` alone.
 *  - **`introducedAt`.** The new-item faucet is "max 8 new items per day"
 *    (section 3), which is a question about today, not about all time.
 */
export interface ItemState {
  itemId: string;
  nodeIds: string[];
  status: ItemStatus;
  /** Start 2.3, clamped to [1.3, 2.9]. */
  ease: number;
  intervalDays: number;
  dueAt: number;
  reps: number;
  lapses: number;
  /** Exponential moving accuracy, alpha 0.3. */
  accEMA: number;
  /** Exponential moving latency in ms, alpha 0.3. */
  latEMA: number;
  /** Position in the learning steps. Meaningless once status is `review`. */
  step: number;
  /** Last 10 reps, oldest first. */
  history: RepHistoryEntry[];
  /** When this item was first served. Null until it has been. */
  introducedAt: number | null;
  updatedAt: number;
}

/**
 * One graded rep, append-only (architecture.md section 8).
 *
 * `nodeIds` is denormalised onto the row on purpose. Node mastery is rebuilt by
 * replaying this log, and a rep whose item has since left the pool would
 * otherwise be unattributable — which is exactly the case a rebuild exists for.
 */
export interface RepRow {
  /** `${sessionId}:${seq}`, zero-padded, so key order is time order. */
  id: string;
  ts: number;
  sessionId: string;
  itemId: string;
  drillId: string;
  nodeIds: string[];
  rating: Rating;
  correct: boolean;
  latencyMs: number | null;
  timingStats: TimingStats | null;
  /** Legato and articulation drills. Absent for everything V1 grades today. */
  inBandShare?: number;
  /** Set when this rep was a component of a fused exercise (section 5.4). */
  fusedFrom?: string;
}

export type SessionMode = 'scheduled' | 'free';

/**
 * session-generator.md section 7. Stored on the row rather than recomputed,
 * because re-entry lasts "2 sessions" and the second one opens after a normal
 * one-day gap: without the first session saying what it was, the run length is
 * not recoverable.
 */
export type ReturnMode = 'normal' | 'gentle' | 're-entry';

/**
 * One session (architecture.md section 8), which is also the row
 * `practice.summary()` has been producing since slice 4.
 *
 * This is the table that answers the only question that matters in weeks 1 and
 * 2 (CLAUDE.md): sessions per week. A row is written when a session **starts**,
 * not when it ends, and updated as it runs. A session that ends with the tab
 * being closed still happened, and a metric that quietly drops those is a
 * metric that flatters a bad week.
 */
export interface SessionRow {
  id: string;
  startTs: number;
  endTs: number | null;
  durationMin: number;
  /** The preset the session was opened with, in minutes. Null in free practice. */
  plannedBudgetMin: number | null;
  mode: SessionMode;
  returnMode: ReturnMode;
  nodeIds: string[];
  /** Minutes per track, for section 6's track shares. One track exists so far. */
  trackMinutes: Partial<Record<Track, number>>;
  reps: number;
  correct: number;
  /** Rolling accuracy over the last 30 graded reps, at the time of the last rep. */
  rollingAccuracy: number;
}

/** Where one item's events start and stop inside a session's raw stream. */
export interface RawMidiBoundary {
  itemId: string;
  drillId: string;
  /** Indices into `events`, half-open. */
  from: number;
  to: number;
  promptReadyAt: number;
}

/**
 * A session's full event stream (architecture.md section 8).
 *
 * "Exists so tolerance changes (they WILL change in weeks 1-2) can re-grade
 * recent history instead of poisoning it." Kept for the last 20 sessions and
 * then dropped, oldest first.
 */
export interface RawMidiSession {
  sessionId: string;
  startTs: number;
  events: NormalizedEvent[];
  boundaries: RawMidiBoundary[];
}

export const RAW_MIDI_SESSIONS = 20;

/**
 * Everything architecture.md section 8 lists, plus the numbers section 9 and
 * session-generator.md section 10 predict will be wrong within two weeks. They
 * are settings rather than constants precisely because those two sections say
 * so: "keep them settings, not constants".
 */
export interface Settings {
  /** Hands are indistinguishable at the protocol level; this is the only split. */
  splitPoint: number;
  hasPedal: boolean;
  /** App-level transpose for material outside the 61-key window. */
  transposeOffset: number;
  /** Session budget presets in minutes, and the default. */
  budgetPresetsMin: number[];
  defaultBudgetMin: number;
  /** After this hour, the default budget drops to `lateBudgetMin`. */
  lateHour: number;
  lateBudgetMin: number;
  targetShares: Record<Track, number>;
  latencyBandsMs: { automaticMs: number; knownMs: number };
  /** Max new items per day, across all nodes (section 3). */
  newItemsPerDay: number;
  /** Softmax temperature for item selection (section 4). */
  selectionTemperature: number;
  /** Suspend as a leech at this many lapses (section 9). */
  leechLapses: number;
  /** Last time a backup was exported, for the weekly nudge (section 8). */
  lastBackupAt: number | null;
  /** First run stamp. Also what `navigator.storage.persist()` keys off. */
  firstRunAt: number;
  persistGranted: boolean;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'firstRunAt'> = {
  splitPoint: 60,
  hasPedal: false,
  transposeOffset: 0,
  budgetPresetsMin: [5, 10, 15, 25],
  defaultBudgetMin: 15,
  lateHour: 22,
  lateBudgetMin: 10,
  targetShares: { 'keyboard-theory': 0.4, 'physical-rhythm': 0.35, ear: 0.25 },
  latencyBandsMs: { automaticMs: 1200, knownMs: 3000 },
  newItemsPerDay: 8,
  selectionTemperature: 0.7,
  leechLapses: 8,
  lastBackupAt: null,
  persistGranted: false,
};

/** The whole database as one JSON document, for export and import. */
export interface Backup {
  schemaVersion: number;
  treeVersion: number;
  exportedAt: number;
  settings: Settings;
  itemState: ItemState[];
  repLog: RepRow[];
  sessionLog: SessionRow[];
  rawMidi: RawMidiSession[];
}
