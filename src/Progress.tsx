/**
 * The progress screen: what the store now knows.
 *
 * The layout is an argument about priority. **Sessions per week is first and
 * largest**, because CLAUDE.md says it is the only metric that matters in weeks
 * 1 and 2, and architecture.md section 9.6 attaches a decision to it: five or
 * more means the design is holding, three or fewer means shrink the session
 * rather than tune anything. A number that drives a decision should not be
 * three panels down from a mastery chart.
 *
 * Mastery comes second and is deliberately undramatic. It is the only currency
 * the design allows (CLAUDE.md: "Gamification is the skill tree. Do not add XP,
 * badges, or streak layers on top of it"), so there is no streak counter here,
 * no total-reps trophy and no deficit. Section 6: "The generator never displays
 * a deficit, owed backlog, or broken anything."
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  downloadBackup,
  readBackupFile,
  store,
  useProgressStore,
  type WeekSummary,
} from './store/index.ts';
import { deriveProgress, sessionCapacity } from './schedule/index.ts';
import type { NodeProgress } from './schedule/index.ts';
import { itemById } from './drills/index.ts';
import { nodeName } from './tree.ts';

const pct = (v: number) => `${Math.round(v * 100)}%`;

const dateLabel = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function bytes(n: number | null): string {
  if (n === null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const VERDICT_TEXT: Record<string, string> = {
  holding:
    'Five or more sessions in a week is the design holding (architecture.md section 9.6).',
  watch: 'Four. One short of the line where the design is considered to be holding.',
  failing:
    'Three or fewer. Section 9.6 says the response is not to tune thresholds: shrink the default session to 10 minutes and make the warm-up the whole front half.',
  unknown: 'Not enough of the week has passed for the count to mean anything yet.',
};

/** The headline. Everything else on this screen is subordinate to it. */
function AdherencePanel() {
  const s = useProgressStore();
  // Not memoised: it is a pass over one row per session, and the input is the
  // clock as much as the data, so there is no honest dependency to key on.
  const report = s.adherence();
  const week = report.thisWeek;

  return (
    <div className="panel wide">
      <h2>
        Sessions this week
        <span className="h2-note">the only metric that matters in weeks 1-2</span>
      </h2>

      <div className="counters">
        <div>
          <span className={`num huge ${report.verdict}`}>{week?.sessions ?? 0}</span>
          <span className="lbl">sessions</span>
        </div>
        <div>
          <span className="num">{week?.days ?? 0}</span>
          <span className="lbl">days played</span>
        </div>
        <div>
          <span className="num">{Math.round(week?.minutes ?? 0)}</span>
          <span className="lbl">minutes</span>
        </div>
        <div>
          <span className="num">
            {report.meanPerWeek === null ? '-' : report.meanPerWeek.toFixed(1)}
          </span>
          <span className="lbl">per week, last 4</span>
        </div>
      </div>

      <p className="note muted">{VERDICT_TEXT[report.verdict]}</p>

      {report.daysSinceLast !== null && report.daysSinceLast > 0 && (
        <p className="note muted">
          Last session {report.daysSinceLast} day{report.daysSinceLast === 1 ? '' : 's'}{' '}
          ago. {returnNote(s.returnModeNow())}
        </p>
      )}

      {report.weeks.length > 1 && <WeekTable weeks={report.weeks.slice(0, 8)} />}
    </div>
  );
}

function returnNote(mode: string): string {
  if (mode === 're-entry') {
    return 'The next two sessions are re-entry: ten minutes, strongest items only, no new material. Rebuild the habit before the skill.';
  }
  if (mode === 'gentle') {
    return 'The next session is shorter and introduces nothing new.';
  }
  return '';
}

function WeekTable({ weeks }: { weeks: readonly WeekSummary[] }) {
  return (
    <table className="cc-table">
      <thead>
        <tr>
          <th>week of</th>
          <th>sessions</th>
          <th>days</th>
          <th>min</th>
          <th>reps</th>
          <th>accuracy</th>
        </tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={w.weekStart}>
            <td className="strong">{dateLabel(w.weekStart)}</td>
            <td className={w.sessions >= 5 ? 'ok' : w.sessions <= 3 ? 'miss' : undefined}>
              {w.sessions}
            </td>
            <td>{w.days}</td>
            <td>{Math.round(w.minutes)}</td>
            <td>{w.reps}</td>
            <td>{w.reps === 0 ? '-' : pct(w.accuracy)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What the scheduler would serve if a session started right now. */
function SchedulerPanel({ progress }: { progress: ReadonlyMap<string, NodeProgress> }) {
  const s = useProgressStore();
  const due = s.dueNow();
  const budget = s.defaultBudgetMin();
  const capacity = sessionCapacity(budget);
  const active = [...progress.values()].filter((p) => p.lifecycle === 'learning');

  return (
    <div className="panel">
      <h2>Up next</h2>
      <div className="counters">
        <div>
          <span className="num">{due}</span>
          <span className="lbl">due now</span>
        </div>
        <div>
          <span className="num">{s.newItemsLeftToday()}</span>
          <span className="lbl">new left today</span>
        </div>
        <div>
          <span className="num">{budget}</span>
          <span className="lbl">minutes</span>
        </div>
      </div>
      <p className="note muted">
        A {budget}-minute session is about {capacity} reps, so at most{' '}
        {Math.ceil(capacity * 1.5)} due items get served and the rest are pushed back
        silently. Nodes in play:{' '}
        {active.length === 0 ? 'none' : active.map((p) => nodeName(p.nodeId)).join(', ')}.
      </p>
    </div>
  );
}

function MasteryPanel({ progress }: { progress: ReadonlyMap<string, NodeProgress> }) {
  const rows = useMemo(
    () =>
      [...progress.values()]
        .filter((p) => p.drillable || p.node.isV1 === true)
        .sort((a, b) => {
          const order = ['learning', 'unlocked', 'complete', 'locked'];
          const d = order.indexOf(a.lifecycle) - order.indexOf(b.lifecycle);
          return d !== 0 ? d : b.mastery - a.mastery;
        }),
    [progress]
  );

  return (
    <div className="panel wide">
      <h2>
        The tree
        <span className="h2-note">mastered items over the count the tree declares</span>
      </h2>
      <div className="table-scroll">
        <table className="cc-table">
          <thead>
            <tr>
              <th>node</th>
              <th>state</th>
              <th>mastery</th>
              <th>automatic</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const note = nodeNote(p);
              return (
                <tr key={p.nodeId}>
                  {/* The note sits under the name rather than in a column of
                      its own: it is a sentence among numbers, and a fifth
                      column of sentences pushes the table past the panel. */}
                  <td className="node-cell">
                    <span className="strong">{p.node.name}</span>
                    {note && <span className="node-note">{note}</span>}
                  </td>
                  <td className={`life ${p.lifecycle}`}>
                    {p.lifecycle}
                    {p.decayed && <span className="flag">decayed</span>}
                  </td>
                  <td>
                    <span className="progress">
                      <span style={{ width: pct(p.mastery) }} />
                    </span>{' '}
                    {p.mastered}/{p.itemCount}
                  </td>
                  <td>{p.measurable && p.drillable ? pct(p.automaticShare) : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note muted">
        Mastery counts items whose last three reps were correct, whose accuracy is over
        the node&apos;s threshold, and whose moving latency is under the automatic band.
        The denominator is the item count the tree declares, not the number that happen to
        have drills, so a node is never complete because only part of it is built.
      </p>
    </div>
  );
}

function nodeNote(p: NodeProgress): string {
  if (!p.measurable) return `${p.node.masteryThreshold.type} grader not built yet`;
  if (!p.drillable) return 'no drill yet';
  if (p.blockedBy.length > 0) return `waiting on ${p.blockedBy.map(nodeName).join(', ')}`;
  if (p.missingRequires.length > 0) return `needs ${p.missingRequires.join(', ')}`;
  if (p.bypassedDeps.length > 0) {
    return `${p.bypassedDeps.map(nodeName).join(', ')} has no drill yet, so it is not gating`;
  }
  return '';
}

/** Suspended leeches. Surfaced once, never re-served silently (section 9). */
function LeechPanel() {
  const s = useProgressStore();
  const leeches = s.leeches();
  if (leeches.length === 0) return null;

  return (
    <div className="panel">
      <h2>
        Needs a different approach
        <span className="h2-note">suspended from the queue</span>
      </h2>
      <ul className="rep-list">
        {leeches.map((state) => (
          <li key={state.itemId}>
            <span className="rep-item">
              {itemById(state.itemId)?.label ?? state.itemId}
            </span>
            <span className="muted">{state.lapses} lapses</span>
            <button onClick={() => void store.reviveItem(state.itemId)}>put back</button>
          </li>
        ))}
      </ul>
      <p className="note muted">
        These are not being served. Re-serving the same failing form on a timer is what
        section 9 forbids: halve the tempo, take one hand, or split it into steps, and
        then put it back.
      </p>
    </div>
  );
}

function StoragePanel() {
  const s = useProgressStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const doExport = useCallback(async () => {
    const backup = await store.exportBackup();
    downloadBackup(backup);
    await store.writeSettings({ lastBackupAt: Date.now() });
    setMessage(
      `Exported ${backup.repLog.length} reps and ${backup.sessionLog.length} sessions.`
    );
  }, []);

  const doImport = useCallback(async (file: File) => {
    try {
      const backup = await readBackupFile(file);
      const ok = window.confirm(
        `Import ${backup.repLog.length} reps and ${backup.sessionLog.length} sessions from ${file.name}?\n\n` +
          `This REPLACES everything currently stored. Export first if you are not sure.`
      );
      if (!ok) return;
      await store.importBackup(backup);
      setMessage('Imported. Everything was replaced.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <div className="panel">
      <h2>Storage</h2>
      <div className="readout">
        <span>persisted</span>
        <span className={s.storage?.persisted ? 'ok' : 'warn'}>
          {s.storage?.persisted ? 'yes' : 'not granted'}
        </span>
        <span>used</span>
        <span className="mono">{bytes(s.storage?.usageBytes ?? null)}</span>
        <span>reps kept</span>
        <span className="mono">{s.recentReps.length} in memory</span>
        <span>items tracked</span>
        <span className="mono">{s.itemState.size}</span>
      </div>

      {!s.storage?.persisted && (
        <p className="note warn-note">
          Chrome has not granted persistent storage, so this data can be evicted under
          disk pressure. It usually grants it after the site has been used a few times.
          Export a backup in the meantime.
        </p>
      )}

      {s.backupOverdue() && (
        <p className="note warn-note">
          No backup in the last week. There is no server and no sync: a file in Downloads
          is the entire recovery plan.
        </p>
      )}

      <div className="toolbar">
        <button className="primary" onClick={() => void doExport()}>
          Export JSON
        </button>
        <button onClick={() => fileInput.current?.click()}>Import</button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void doImport(file);
          }}
        />
        <button
          onClick={() => {
            void store.rebuildItemState().then((n) => setMessage(`Rebuilt ${n} items.`));
          }}
          title="Replay the rep log to regenerate every item's scheduling state."
        >
          Rebuild from log
        </button>
      </div>
      {message && <p className="note muted">{message}</p>}
    </div>
  );
}

export default function ProgressScreen() {
  const s = useProgressStore();

  useEffect(() => {
    void store.load();
  }, []);

  const { itemState, completedAt, settings } = s;
  const derived = useMemo(
    () =>
      deriveProgress(itemState, {
        bands: settings.latencyBandsMs,
        completedAt,
        satisfiedRequires: settings.hasPedal ? ['pedal'] : [],
      }),
    [itemState, completedAt, settings]
  );

  if (s.status === 'error') {
    return (
      <div className="screen">
        <div className="banner err">
          <div>
            <strong>The store did not open.</strong> {s.error}
          </div>
        </div>
      </div>
    );
  }

  if (s.status !== 'ready') {
    return (
      <div className="screen">
        <p className="muted">Opening the store...</p>
      </div>
    );
  }

  return (
    <div className="screen">
      <AdherencePanel />
      <div className="panels">
        <SchedulerPanel progress={derived.progress} />
        <StoragePanel />
        <LeechPanel />
      </div>
      <MasteryPanel progress={derived.progress} />
      <p className="note muted">
        Nothing on this page is stored except the reps and the sessions themselves.
        Mastery, unlock state and the active set are recomputed from the item states every
        time this screen renders, which is what makes re-grading recent history with
        different tolerances survivable rather than destructive.
      </p>
    </div>
  );
}
