/**
 * Sessions per week.
 *
 * CLAUDE.md: "instrument sessions per week from day one. In weeks 1-2 that is
 * the only metric that matters." architecture.md section 9.6 says what it is
 * for: ">= 5 -> the design is holding. <= 3 -> don't tune thresholds, shrink
 * the default session to 10 min and make the warm-up the whole front half. The
 * tree can be wrong for months and recover; the habit can't."
 *
 * So this file exists before the scheduler does, and it is deliberately the
 * dullest arithmetic in the app. Three decisions in it are not obvious:
 *
 * **A session counts when it has a graded rep.** Not when it reaches five
 * minutes. Section 6's "minimum viable session = 5 minutes and counts fully" is
 * about what the generator is allowed to *offer*; a two-minute session that
 * happened is still a day the habit held, and a metric that discards it would
 * report a worse week than the one that occurred. Opening the app and playing
 * nothing is not a session, which is why the floor is one rep rather than zero.
 *
 * **Days are reported next to sessions.** Five sessions in one Sunday is not
 * the same fact as five sessions across five days, and the threshold in section
 * 9.6 plainly means the second. Reporting only the headline number would let
 * one binge read as a held habit.
 *
 * **Weeks start on Monday, in local time.** An ISO week, so "this week" means
 * what a human means by it. Local rather than UTC because an 11pm Sunday
 * session in this timezone is a Sunday session.
 */

import type { ReturnMode, SessionRow } from './types.ts';

/** Monday = 1, matching ISO. Sunday would be 0. */
export const WEEK_STARTS_ON = 1;

/** Local midnight beginning the week containing `ts`. */
export function weekStart(ts: number, startsOn: number = WEEK_STARTS_ON): number {
  const d = new Date(ts);
  const shift = (d.getDay() - startsOn + 7) % 7;
  // Constructed from local parts, so a week spanning a DST change is still
  // seven local days rather than seven times 24 hours.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift).getTime();
}

/** Local midnight beginning the day containing `ts`. */
export function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export const DAY_MS = 86_400_000;

/** Whole local days between two instants. Calendar days, not 24-hour blocks. */
export function daysBetween(from: number, to: number): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS);
}

export interface WeekSummary {
  /** Local midnight of the Monday. */
  weekStart: number;
  sessions: number;
  /** Distinct local days with at least one session. Never above 7. */
  days: number;
  minutes: number;
  reps: number;
  correct: number;
  /** Over the week's reps. Zero when there were none. */
  accuracy: number;
}

/** A session that happened: it graded something. */
export const counts = (s: SessionRow): boolean => s.reps > 0;

/**
 * One summary per week that has a session, newest first, with empty weeks
 * between them filled in. A skipped week is the single most informative row on
 * the screen and it must not be silently absent.
 */
export function weeklySummaries(
  sessions: readonly SessionRow[],
  now: number = Date.now()
): WeekSummary[] {
  const played = sessions.filter(counts);
  if (played.length === 0) return [];

  const byWeek = new Map<number, SessionRow[]>();
  for (const s of played) {
    const key = weekStart(s.startTs);
    const list = byWeek.get(key);
    if (list) list.push(s);
    else byWeek.set(key, [s]);
  }

  const first = Math.min(...byWeek.keys());
  const out: WeekSummary[] = [];
  for (let w = weekStart(now); w >= first; w = weekStart(w - DAY_MS)) {
    const rows = byWeek.get(w) ?? [];
    const reps = rows.reduce((n, r) => n + r.reps, 0);
    out.push({
      weekStart: w,
      sessions: rows.length,
      days: new Set(rows.map((r) => dayStart(r.startTs))).size,
      minutes: rows.reduce((n, r) => n + r.durationMin, 0),
      reps,
      correct: rows.reduce((n, r) => n + r.correct, 0),
      accuracy: reps === 0 ? 0 : rows.reduce((n, r) => n + r.correct, 0) / reps,
    });
  }
  return out;
}

export type Adherence = 'holding' | 'watch' | 'failing' | 'unknown';

/**
 * architecture.md section 9.6, verbatim: 5 or more sessions is the design
 * holding, 3 or fewer is the signal to shrink the session rather than tune
 * thresholds. Four is the gap between them and is named rather than rounded
 * into one side.
 *
 * `unknown` is the first week, where the count is not yet a week's worth of
 * evidence. Calling a Tuesday with two sessions "failing" would be arithmetic
 * pretending to be a judgement.
 */
export function adherence(week: WeekSummary | undefined, now: number): Adherence {
  if (!week) return 'unknown';
  const elapsedDays = daysBetween(week.weekStart, now) + 1;
  if (elapsedDays < 7 && week.sessions < 5) return 'unknown';
  if (week.sessions >= 5) return 'holding';
  if (week.sessions <= 3) return 'failing';
  return 'watch';
}

export interface AdherenceReport {
  weeks: WeekSummary[];
  thisWeek: WeekSummary | undefined;
  verdict: Adherence;
  /** Whole days since the last session with a rep. Null if there has never been one. */
  daysSinceLast: number | null;
  lastSessionTs: number | null;
  /** Sessions per week over the last four complete weeks. Null before there are any. */
  meanPerWeek: number | null;
  totalSessions: number;
}

export function adherenceReport(
  sessions: readonly SessionRow[],
  now: number = Date.now()
): AdherenceReport {
  const weeks = weeklySummaries(sessions, now);
  const thisWeek = weeks[0];
  const played = sessions.filter(counts);
  const lastSessionTs =
    played.length === 0 ? null : Math.max(...played.map((s) => s.startTs));

  // Complete weeks only: the current one is still being written and would drag
  // any average down every Monday morning.
  const complete = weeks.slice(1, 5);
  const meanPerWeek =
    complete.length === 0
      ? null
      : complete.reduce((n, w) => n + w.sessions, 0) / complete.length;

  return {
    weeks,
    thisWeek,
    verdict: adherence(thisWeek, now),
    daysSinceLast: lastSessionTs === null ? null : daysBetween(lastSessionTs, now),
    lastSessionTs,
    meanPerWeek,
    totalSessions: played.length,
  };
}

/**
 * session-generator.md section 7. The gap since the last session decides how
 * the next one is shaped, and the whole point is that a long gap makes the
 * return session *easier*: "skip a week -> open app -> get punished by a wall
 * of due items -> close app forever" is the failure mode being designed out.
 */
export function gapReturnMode(daysSinceLast: number | null): ReturnMode {
  // A first session is a normal session. There is nothing to be gentle about.
  if (daysSinceLast === null) return 'normal';
  if (daysSinceLast > 7) return 're-entry';
  if (daysSinceLast >= 4) return 'gentle';
  return 'normal';
}

/** section 7: re-entry is two sessions, then it exits by itself. */
export const RE_ENTRY_SESSIONS = 2;

/**
 * The mode for the session about to start.
 *
 * The gap alone is not enough. Re-entry lasts two sessions, and by the time the
 * second one opens the gap is a single day, which reads as normal. So a run
 * that has not finished carries over, counted from the stored `returnMode` of
 * the sessions that have already run.
 */
export function nextReturnMode(
  sessions: readonly SessionRow[],
  now: number = Date.now()
): ReturnMode {
  const played = sessions.filter(counts).sort((a, b) => a.startTs - b.startTs);
  const last = played[played.length - 1];
  const fromGap = gapReturnMode(last ? daysBetween(last.startTs, now) : null);
  if (fromGap === 're-entry') return 're-entry';

  let run = 0;
  for (
    let i = played.length - 1;
    i >= 0 && played[i]!.returnMode === 're-entry';
    i -= 1
  ) {
    run += 1;
  }
  return run > 0 && run < RE_ENTRY_SESSIONS ? 're-entry' : fromGap;
}
