/**
 * Tests for sessions per week.
 *
 * This is the metric CLAUDE.md calls the only one that matters in weeks 1 and
 * 2, and the decision it drives is not a tweak: at 3 or fewer, architecture.md
 * section 9.6 says stop tuning thresholds and halve the session. So the ways it
 * could quietly lie are worth pinning down. It could drop a session that ended
 * with the tab being closed, count five sessions in one Sunday as a held habit,
 * or hide a skipped week by simply not having a row for it.
 */

import { describe, expect, it } from 'vitest';
import {
  RE_ENTRY_SESSIONS,
  adherence,
  adherenceReport,
  dayStart,
  daysBetween,
  gapReturnMode,
  nextReturnMode,
  weekStart,
  weeklySummaries,
} from './weeks.ts';
import type { ReturnMode, SessionRow } from './types.ts';

/** A Wednesday, so week boundaries are never accidentally right. */
const WED = new Date(2026, 7, 12, 10, 0, 0).getTime();
const MON = new Date(2026, 7, 10, 0, 0, 0).getTime();
const DAY = 86_400_000;

function session(startTs: number, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: `s${startTs}`,
    startTs,
    endTs: startTs + 600_000,
    durationMin: 10,
    plannedBudgetMin: 15,
    mode: 'scheduled',
    returnMode: 'normal',
    nodeIds: ['kt-inv-maj-triads'],
    trackMinutes: {},
    reps: 30,
    correct: 27,
    rollingAccuracy: 0.9,
    ...over,
  };
}

describe('week boundaries', () => {
  it('starts the week on the Monday containing the day', () => {
    expect(weekStart(WED)).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
    // Sunday belongs to the week that began six days earlier.
    expect(weekStart(MON + 6 * DAY + 23 * 3600_000)).toBe(MON);
    // Monday 00:00 the following week is a new week.
    expect(weekStart(MON + 7 * DAY)).toBe(MON + 7 * DAY);
  });

  it('counts calendar days, not 24-hour blocks', () => {
    const lateNight = new Date(2026, 7, 12, 23, 30).getTime();
    const nextMorning = new Date(2026, 7, 13, 7, 0).getTime();
    // Seven and a half hours apart, but a different day, which is what a
    // "skipped a day" question means.
    expect(daysBetween(lateNight, nextMorning)).toBe(1);
    expect(dayStart(lateNight)).not.toBe(dayStart(nextMorning));
  });
});

describe('weekly summaries', () => {
  it('counts a session that never ended', () => {
    // The tab was closed. It still happened.
    const rows = [session(WED, { endTs: null, durationMin: 4, reps: 12, correct: 11 })];
    expect(weeklySummaries(rows, WED)[0]?.sessions).toBe(1);
  });

  it('does not count opening the app and playing nothing', () => {
    const rows = [session(WED, { reps: 0, correct: 0 })];
    expect(weeklySummaries(rows, WED)).toEqual([]);
  });

  it('separates sessions from the days they happened on', () => {
    // Five sessions, all on one Sunday. Five is the "design is holding"
    // threshold and this is emphatically not that.
    const sunday = MON + 6 * DAY;
    const rows = [0, 1, 2, 3, 4].map((i) => session(sunday + i * 3600_000));
    const week = weeklySummaries(rows, sunday)[0]!;
    expect(week.sessions).toBe(5);
    expect(week.days).toBe(1);
  });

  it('keeps a row for a week with nothing in it', () => {
    const rows = [session(MON), session(MON + 14 * DAY)];
    const weeks = weeklySummaries(rows, MON + 14 * DAY);
    expect(weeks).toHaveLength(3);
    expect(weeks[1]!.sessions).toBe(0);
  });

  it('is newest first', () => {
    const rows = [session(MON), session(MON + 7 * DAY)];
    const weeks = weeklySummaries(rows, MON + 7 * DAY);
    expect(weeks[0]!.weekStart).toBeGreaterThan(weeks[1]!.weekStart);
  });
});

describe('the adherence verdict', () => {
  const week = (sessions: number) => ({
    weekStart: MON,
    sessions,
    days: sessions,
    minutes: sessions * 10,
    reps: sessions * 30,
    correct: sessions * 27,
    accuracy: 0.9,
  });

  it('does not call a Tuesday a failure', () => {
    // Two sessions by Tuesday is not "3 or fewer for the week" yet.
    expect(adherence(week(2), MON + DAY)).toBe('unknown');
  });

  it('calls five sessions holding as soon as they exist', () => {
    expect(adherence(week(5), MON + 2 * DAY)).toBe('holding');
  });

  it('reads the thresholds of section 9.6 at the end of the week', () => {
    const sunday = MON + 6 * DAY;
    expect(adherence(week(3), sunday)).toBe('failing');
    expect(adherence(week(4), sunday)).toBe('watch');
    expect(adherence(week(5), sunday)).toBe('holding');
  });

  it('reports the gap since the last session that graded something', () => {
    const rows = [session(MON), session(MON + DAY, { reps: 0, correct: 0 })];
    expect(adherenceReport(rows, MON + 3 * DAY).daysSinceLast).toBe(3);
  });

  it('averages only the weeks that are over', () => {
    const rows = [session(MON - 7 * DAY), session(MON - 7 * DAY + DAY), session(MON)];
    // One session so far this week must not drag the average down.
    expect(adherenceReport(rows, MON + DAY).meanPerWeek).toBe(2);
  });
});

describe('skip handling', () => {
  it('reads the gaps of section 7', () => {
    expect(gapReturnMode(null)).toBe('normal');
    expect(gapReturnMode(0)).toBe('normal');
    expect(gapReturnMode(3)).toBe('normal');
    expect(gapReturnMode(4)).toBe('gentle');
    expect(gapReturnMode(7)).toBe('gentle');
    expect(gapReturnMode(8)).toBe('re-entry');
  });

  it('carries re-entry across the second session, which has no gap', () => {
    const back = MON + 10 * DAY;
    const rows = [session(MON), session(back, { returnMode: 're-entry' as ReturnMode })];
    // The next day the gap is 1, which reads as normal, but re-entry is two
    // sessions long and this is only the second.
    expect(nextReturnMode(rows, back + DAY)).toBe('re-entry');
  });

  it('exits re-entry by itself after two sessions', () => {
    const back = MON + 10 * DAY;
    const rows = [
      session(MON),
      ...Array.from({ length: RE_ENTRY_SESSIONS }, (_, i) =>
        session(back + i * DAY, { returnMode: 're-entry' as ReturnMode })
      ),
    ];
    expect(nextReturnMode(rows, back + RE_ENTRY_SESSIONS * DAY)).toBe('normal');
  });
});
