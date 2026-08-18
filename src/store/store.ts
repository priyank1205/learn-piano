/**
 * The progress store: the one thing in the app that outlives a page load.
 *
 * Everything slices 1 to 4 built was in memory. This is where a rep stops being
 * a number on screen and becomes history, which is what makes spaced repetition
 * possible at all — and, more to the point of weeks 1 and 2, what makes
 * **sessions per week** countable.
 *
 * Write order is load-bearing. On every rep:
 *
 *   1. the `repLog` row, which is the authoritative fact
 *   2. the `itemState` it produced, which is derivable from the row
 *   3. the `sessionLog` row's running counts
 *
 * localForage has no cross-store transaction, so a crash lands between two of
 * those. Writing the fact first means the worst case is a derived value one rep
 * behind, and `rebuildItemState()` recovers it by replaying the log, because
 * `applyRating` is a deterministic function of the rating sequence. The reverse
 * order would lose the fact and keep a state nothing can explain.
 *
 * Raw MIDI is the exception: it is buffered and flushed periodically rather
 * than written per rep. It exists so tolerance changes can re-grade recent
 * history (architecture.md section 8), so losing the tail of one session to a
 * crashed tab costs a re-grade, not a fact.
 */

import { useSyncExternalStore } from 'react';
import { stores, openSchema, readAll, requestPersistence } from './db.ts';
import type { StorageReport } from './db.ts';
import {
  DEFAULT_SETTINGS,
  RAW_MIDI_SESSIONS,
  SCHEMA_VERSION,
  type Backup,
  type ItemState,
  type RawMidiBoundary,
  type RawMidiSession,
  type RepRow,
  type ReturnMode,
  type SessionMode,
  type SessionRow,
  type Settings,
} from './types.ts';
import { adherenceReport, dayStart, nextReturnMode } from './weeks.ts';
import type { AdherenceReport } from './weeks.ts';
import {
  applyRating,
  inSchedule,
  newItemState,
  nudgeLatency,
  ratingFor,
  ratingForPass,
  revive,
} from '../schedule/srs.ts';
// Straight from the modules rather than through `grade/index.ts`: the barrel
// exports the runner, and the store has no business importing React.
import { isClean } from '../grade/match.ts';
import { summariseOverlap } from '../grade/legato.ts';
import { withTolerances } from '../grade/types.ts';
import type { Tolerances } from '../grade/types.ts';
import type { DrillItem } from '../drills/types.ts';
import { itemById } from '../drills/registry.ts';
import type { Rep } from '../grade/index.ts';
import { TREE_VERSION } from '../tree.ts';

/** Reps kept in memory, for the rolling-accuracy window and the recent list. */
const RECENT_REPS = 300;

/** section 9's difficulty governor works over the last 30 graded reps. */
export const ROLLING_WINDOW = 30;

/** Raw MIDI is flushed every this many reps, and at session end. */
const RAW_FLUSH_EVERY = 10;

/** One week between backup nudges (architecture.md section 8). */
export const BACKUP_NUDGE_MS = 7 * 86_400_000;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Ids sort chronologically as strings, which is what makes `readAll` ordered. */
const newSessionId = (startTs: number): string =>
  `s${pad(startTs, 13)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const repKey = (sessionId: string, seq: number): string => `${sessionId}#${pad(seq, 5)}`;

const MILESTONE_KEY = `nodeMilestones:v${TREE_VERSION}`;

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RepInput {
  item: DrillItem;
  rep: Rep;
}

class ProgressStore {
  status: StoreStatus = 'idle';
  error: string | null = null;

  settings: Settings = { ...DEFAULT_SETTINGS, firstRunAt: Date.now() };
  /**
   * Replaced rather than mutated on every write. This is a
   * `useSyncExternalStore` snapshot, so anything derived from it with `useMemo`
   * compares it by identity: setting a key in place re-renders the progress
   * screen with the previous mastery numbers, which looks exactly like the
   * scheduler being broken. Copying a map of a few thousand entries per rep
   * costs nothing next to the IndexedDB write it accompanies.
   */
  itemState: ReadonlyMap<string, ItemState> = new Map();
  sessions: readonly SessionRow[] = [];
  /** The tail of `repLog`, newest last. The whole log is never held in memory. */
  recentReps: readonly RepRow[] = [];
  /** Node id -> when its threshold was first met. See mastery.ts. */
  completedAt: Record<string, number> = {};
  storage: StorageReport | null = null;

  current: SessionRow | null = null;

  private seq = 0;
  private rawEvents: RawMidiSession | null = null;
  private rawSinceFlush = 0;
  private subs = new Set<() => void>();
  private snapshot = 0;
  private loading: Promise<void> | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  getSnapshot = (): number => this.snapshot;

  private bump(): void {
    this.snapshot += 1;
    for (const fn of this.subs) fn();
  }

  /** Idempotent: several screens mount at once and all of them call this. */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    this.status = 'loading';
    this.bump();
    try {
      const { firstRun } = await openSchema();

      const stored = await stores.settings.getItem<Settings>('settings');
      this.settings = stored
        ? { ...DEFAULT_SETTINGS, ...stored }
        : { ...DEFAULT_SETTINGS, firstRunAt: Date.now() };

      const [items, sessions, reps, milestones] = await Promise.all([
        readAll<ItemState>(stores.itemState),
        readAll<SessionRow>(stores.sessionLog),
        readAll<RepRow>(stores.repLog),
        stores.meta.getItem<Record<string, number>>(MILESTONE_KEY),
      ]);

      this.itemState = new Map(items.map((s) => [s.itemId, s]));
      this.sessions = sessions.sort((a, b) => a.startTs - b.startTs);
      this.recentReps = reps.slice(-RECENT_REPS);
      this.completedAt = milestones ?? {};

      // Requested on first run (architecture.md section 8), and re-checked
      // after that so the report on screen is current rather than a memory of
      // what Chrome said on day one.
      this.storage = await requestPersistence();
      if (firstRun || this.settings.persistGranted !== this.storage.persisted) {
        await this.writeSettings({ persistGranted: this.storage.persisted });
      }

      this.status = 'ready';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.status = 'error';
    }
    this.bump();
  }

  // ---------------------------------------------------------------- settings

  async writeSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await stores.settings.setItem('settings', this.settings);
    this.bump();
  }

  /**
   * The tolerance overrides the user has calibrated, applied to every prompt the
   * practice loop arms (`drills/present.ts`).
   *
   * One number so far. architecture.md section 9 names several that will need
   * moving in the first fortnight and this is the mechanism they move through:
   * a setting, merged over the template's own tolerances at instantiation, so
   * that recalibrating a band is never a code edit and never a per-drill one.
   */
  tolerances(): Partial<Tolerances> {
    return { legatoBandMs: this.settings.legatoBandMs };
  }

  /**
   * section 6: "after 22:00 local: default drops to 10 min, review-only ...
   * the point is a lower default activation energy, not a rule".
   */
  defaultBudgetMin(now: number = Date.now()): number {
    return new Date(now).getHours() >= this.settings.lateHour
      ? this.settings.lateBudgetMin
      : this.settings.defaultBudgetMin;
  }

  // ------------------------------------------------------------- adherence

  /** The metric that decides everything in weeks 1 and 2 (CLAUDE.md). */
  adherence(now: number = Date.now()): AdherenceReport {
    return adherenceReport(this.sessions, now);
  }

  /** Rolling accuracy over the last 30 graded reps. Null before there are any. */
  rollingAccuracy(): number | null {
    const window = this.recentReps.slice(-ROLLING_WINDOW);
    if (window.length === 0) return null;
    return window.filter((r) => r.correct).length / window.length;
  }

  /** Yesterday's accuracy, for section 3's load guard. Null if nothing ran. */
  yesterdayAccuracy(now: number = Date.now()): number | null {
    const start = dayStart(now) - 86_400_000;
    const rows = this.sessions.filter(
      (s) => s.startTs >= start && s.startTs < dayStart(now) && s.reps > 0
    );
    if (rows.length === 0) return null;
    const reps = rows.reduce((n, r) => n + r.reps, 0);
    return reps === 0 ? null : rows.reduce((n, r) => n + r.correct, 0) / reps;
  }

  /** New items already introduced today, against the daily faucet (section 3). */
  newItemsToday(now: number = Date.now()): number {
    const start = dayStart(now);
    let n = 0;
    for (const s of this.itemState.values()) {
      if (s.introducedAt !== null && s.introducedAt >= start) n += 1;
    }
    return n;
  }

  newItemsLeftToday(now: number = Date.now()): number {
    return Math.max(0, this.settings.newItemsPerDay - this.newItemsToday(now));
  }

  returnModeNow(now: number = Date.now()): ReturnMode {
    return nextReturnMode(this.sessions, now);
  }

  backupOverdue(now: number = Date.now()): boolean {
    const last = this.settings.lastBackupAt;
    return this.sessions.length > 0 && (last === null || now - last > BACKUP_NUDGE_MS);
  }

  // -------------------------------------------------------------- sessions

  /**
   * Open a session. The row is written **now**, not at the end: a session that
   * ends with the tab being closed still happened, and a sessions-per-week
   * number that quietly drops those flatters a bad week, which is the one thing
   * this metric must never do.
   */
  async startSession(opts: {
    mode: SessionMode;
    nodeIds: readonly string[];
    budgetMin: number | null;
    returnMode?: ReturnMode;
    now?: number;
  }): Promise<SessionRow> {
    const now = opts.now ?? Date.now();
    if (this.current) await this.endSession(now);

    const row: SessionRow = {
      id: newSessionId(now),
      startTs: now,
      endTs: null,
      durationMin: 0,
      plannedBudgetMin: opts.budgetMin,
      mode: opts.mode,
      returnMode: opts.returnMode ?? this.returnModeNow(now),
      nodeIds: [...opts.nodeIds],
      trackMinutes: {},
      reps: 0,
      correct: 0,
      rollingAccuracy: this.rollingAccuracy() ?? 0,
    };

    this.seq = 0;
    this.current = row;
    this.rawEvents = { sessionId: row.id, startTs: now, events: [], boundaries: [] };
    this.rawSinceFlush = 0;
    this.sessions = [...this.sessions, row];
    await stores.sessionLog.setItem(row.id, row);
    this.bump();
    return row;
  }

  async endSession(now: number = Date.now()): Promise<void> {
    const row = this.current;
    if (!row) return;
    this.current = null;

    const ended: SessionRow = {
      ...row,
      endTs: now,
      durationMin: (now - row.startTs) / 60000,
    };
    this.replaceSession(ended);
    await stores.sessionLog.setItem(ended.id, ended);
    await this.flushRaw();
    this.rawEvents = null;
    this.bump();
  }

  private replaceSession(row: SessionRow): void {
    this.sessions = this.sessions.map((s) => (s.id === row.id ? row : s));
  }

  // ------------------------------------------------------------------ reps

  /**
   * Persist one graded rep and the scheduling it caused.
   *
   * Returns the rating, which the session planner needs in order to apply
   * section 2's in-session re-queue.
   */
  async recordRep(input: RepInput): Promise<{ row: RepRow; state: ItemState }> {
    const { item, rep } = input;
    const now = Date.now();
    const session = this.current;
    const sessionId = session?.id ?? 'orphan';
    const { correct, latencyMs } = rep.result;

    // "tempoBpm present => timed grading" (architecture.md section 2), and a
    // timed rep is rated by section 2's pass rules rather than by a latency band
    // it does not have.
    const rating =
      rep.spec.expected.tempoBpm === undefined
        ? ratingFor(correct, latencyMs, this.settings.latencyBandsMs)
        : ratingForPass({ correct, notesClean: isClean(rep.result.noteErrors) });

    // Only the legato grader fills `noteOverlapMs`, so only a legato rep gets an
    // `inBandShare`. Summarised against the band this rep was graded under,
    // which is the spec's own tolerances.
    const overlap = rep.result.noteOverlapMs;
    const inBandShare = overlap
      ? summariseOverlap(overlap, withTolerances(rep.spec.grading.tolerances)).inBandShare
      : undefined;

    const row: RepRow = {
      id: repKey(sessionId, this.seq),
      ts: now,
      sessionId,
      itemId: item.itemId,
      drillId: item.templateId,
      nodeIds: [...item.nodeIds],
      rating,
      correct,
      latencyMs,
      timingStats: rep.result.timingErrorMs,
      ...(inBandShare === undefined ? {} : { inBandShare }),
    };
    this.seq += 1;

    // 1. The fact.
    await stores.repLog.setItem(row.id, row);
    this.recentReps = [...this.recentReps, row].slice(-RECENT_REPS);

    // 2. What it did to the schedule.
    const previous =
      this.itemState.get(item.itemId) ?? newItemState(item.itemId, item.nodeIds, now);
    const state = applyRating(previous, rating, correct, latencyMs, {
      now,
      leechLapses: this.settings.leechLapses,
    });
    this.itemState = new Map(this.itemState).set(item.itemId, state);
    await stores.itemState.setItem(item.itemId, state);

    // 3. The session's running counts.
    if (session) {
      const updated: SessionRow = {
        ...session,
        reps: session.reps + 1,
        correct: session.correct + (correct ? 1 : 0),
        rollingAccuracy: this.rollingAccuracy() ?? 0,
        durationMin: (now - session.startTs) / 60000,
      };
      this.current = updated;
      this.replaceSession(updated);
      await stores.sessionLog.setItem(updated.id, updated);
    }

    this.bufferRaw(item, rep);
    this.bump();
    return { row, state };
  }

  /** Write item states the scheduler changed without a rep (backlog postponing). */
  async putItemStates(states: readonly ItemState[]): Promise<void> {
    if (states.length === 0) return;
    const next = new Map(this.itemState);
    for (const state of states) {
      next.set(state.itemId, state);
      await stores.itemState.setItem(state.itemId, state);
    }
    this.itemState = next;
    this.bump();
  }

  /** Items due right now, which is what a session would draw from. */
  dueNow(now: number = Date.now()): number {
    let n = 0;
    for (const state of this.itemState.values()) {
      // `inSchedule`: a harvested row has a latEMA and no reps, and section 8
      // says free-play telemetry never schedules. The planner draws its due pool
      // by the same rule, so this count has to agree with it or the screen
      // promises a session that will not be served.
      if (!inSchedule(state)) continue;
      if (state.status !== 'suspended' && state.dueAt <= now) n += 1;
    }
    return n;
  }

  /**
   * session-generator.md section 8's free-play harvest: nudge one item's
   * `latEMA` from something the user played without being asked.
   *
   * Deliberately not `recordRep`. No rep row is written, no rating is applied,
   * no session counter moves and nothing about scheduling changes, which is
   * section 8's own boundary ("update `latEMA` only, with alpha 0.1 - low-trust
   * telemetry, never scheduling"). The arithmetic, including the rule that the
   * nudge only ever goes up, is in `nudgeLatency`.
   */
  async harvestLatency(itemId: string, latencyMs: number): Promise<void> {
    const item = itemById(itemId);
    if (!item) return;
    const now = Date.now();
    const previous =
      this.itemState.get(itemId) ?? newItemState(itemId, item.nodeIds, now);
    const next = nudgeLatency(previous, latencyMs, now, this.settings.latencyBandsMs);
    // Unchanged means the observation was not slower than what is already known,
    // which is most of them. Writing anyway would churn IndexedDB once a chord
    // and, for an item with no state yet, would leave a row saying nothing.
    if (next === previous) return;
    this.itemState = new Map(this.itemState).set(itemId, next);
    await stores.itemState.setItem(itemId, next);
    this.bump();
  }

  /** Items suspended as leeches, surfaced once and never re-served silently. */
  leeches(): ItemState[] {
    return [...this.itemState.values()].filter((i) => i.status === 'suspended');
  }

  /** Bring a suspended leech back into the queue, on the user's say-so only. */
  async reviveItem(itemId: string): Promise<void> {
    const state = this.itemState.get(itemId);
    if (!state) return;
    await this.putItemStates([revive(state, Date.now(), this.settings.leechLapses)]);
  }

  /**
   * Stamp a node as complete the first time its threshold is observed. Section
   * 1.3's "threshold met once" is the one bit of the derived layer that is not
   * a function of the present, so it is the one bit that gets written down.
   */
  async markComplete(
    nodeIds: readonly string[],
    now: number = Date.now()
  ): Promise<void> {
    const fresh = nodeIds.filter((id) => this.completedAt[id] === undefined);
    if (fresh.length === 0) return;
    this.completedAt = { ...this.completedAt };
    for (const id of fresh) this.completedAt[id] = now;
    await stores.meta.setItem(MILESTONE_KEY, this.completedAt);
    this.bump();
  }

  // -------------------------------------------------------------- raw MIDI

  private bufferRaw(item: DrillItem, rep: Rep): void {
    const raw = this.rawEvents;
    if (!raw) return;
    const from = raw.events.length;
    raw.events.push(...rep.result.raw);
    const boundary: RawMidiBoundary = {
      itemId: item.itemId,
      drillId: item.templateId,
      from,
      to: raw.events.length,
      promptReadyAt: rep.spec.promptReadyAt,
    };
    raw.boundaries.push(boundary);
    this.rawSinceFlush += 1;
    if (this.rawSinceFlush >= RAW_FLUSH_EVERY) void this.flushRaw();
  }

  /** Write the buffer and prune the ring to the last 20 sessions. */
  private async flushRaw(): Promise<void> {
    const raw = this.rawEvents;
    if (!raw || raw.boundaries.length === 0) return;
    this.rawSinceFlush = 0;
    await stores.rawMidi.setItem(raw.sessionId, raw);

    const keys = (await stores.rawMidi.keys()).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - RAW_MIDI_SESSIONS))) {
      await stores.rawMidi.removeItem(key);
    }
  }

  // -------------------------------------------------------- export / import

  async exportBackup(): Promise<Backup> {
    const [itemState, repLog, sessionLog, rawMidi] = await Promise.all([
      readAll<ItemState>(stores.itemState),
      readAll<RepRow>(stores.repLog),
      readAll<SessionRow>(stores.sessionLog),
      readAll<RawMidiSession>(stores.rawMidi),
    ]);
    return {
      schemaVersion: SCHEMA_VERSION,
      treeVersion: TREE_VERSION,
      exportedAt: Date.now(),
      settings: this.settings,
      itemState,
      repLog,
      sessionLog,
      rawMidi,
    };
  }

  /**
   * Replace everything with a backup. Destructive on purpose and confirmed by
   * the screen that calls it: a merge would have to decide what a rep logged
   * against the same item at the same second means in two files, and there is
   * one user on one machine, so that case is a bug rather than a workflow.
   */
  async importBackup(backup: Backup): Promise<void> {
    if (backup.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `That backup is schema ${backup.schemaVersion}; this build understands ${SCHEMA_VERSION}.`
      );
    }
    await Promise.all([
      stores.itemState.clear(),
      stores.repLog.clear(),
      stores.sessionLog.clear(),
      stores.rawMidi.clear(),
    ]);

    for (const s of backup.itemState) await stores.itemState.setItem(s.itemId, s);
    for (const r of backup.repLog) await stores.repLog.setItem(r.id, r);
    for (const s of backup.sessionLog) await stores.sessionLog.setItem(s.id, s);
    for (const r of backup.rawMidi) await stores.rawMidi.setItem(r.sessionId, r);
    if (backup.settings) {
      await stores.settings.setItem('settings', {
        ...DEFAULT_SETTINGS,
        ...backup.settings,
      });
    }

    this.loading = null;
    this.current = null;
    await this.load();
  }

  /**
   * Rebuild every `ItemState` by replaying `repLog`. This is the recovery path
   * the write order exists for, and it is also what a tolerance change will
   * need once re-grading lands: re-grade the raw MIDI, rewrite the log, replay.
   *
   * The intervals it produces will not match the originals to the day, because
   * the fuzz is random and was not recorded. Nothing depends on that: the due
   * dates land within 15% of where they were.
   */
  async rebuildItemState(): Promise<number> {
    const reps = await readAll<RepRow>(stores.repLog);
    const rebuilt = new Map<string, ItemState>();

    for (const row of reps) {
      const nodeIds = itemById(row.itemId)?.nodeIds ?? row.nodeIds;
      const previous =
        rebuilt.get(row.itemId) ?? newItemState(row.itemId, nodeIds, row.ts);
      rebuilt.set(
        row.itemId,
        applyRating(previous, row.rating, row.correct, row.latencyMs, {
          now: row.ts,
          leechLapses: this.settings.leechLapses,
        })
      );
    }

    await stores.itemState.clear();
    for (const state of rebuilt.values()) {
      await stores.itemState.setItem(state.itemId, state);
    }
    this.itemState = rebuilt;
    this.bump();
    return rebuilt.size;
  }
}

export const store = new ProgressStore();

export function useProgressStore(): ProgressStore {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return store;
}
