/**
 * The grader bench.
 *
 * Not the trainer, and not a rival to it: this is one rep at a time with every
 * decision the grader made laid out beside it. The trainer hides all of that on
 * purpose, because a practice screen that shows its own internals is a practice
 * screen nobody practises on. Both drive the same template and the same item
 * pool, so a chord that grades oddly here is the same item, with the same id.
 *
 * What it is really for is the two numbers architecture.md section 9 predicts
 * will be wrong: the 80ms chord window and the 300ms settle. Both are on
 * screen, both are editable, and the cluster panel shows exactly how a rep was
 * carved up, so "that should have counted" is answerable in one glance instead
 * of being tuned around blindly for a fortnight.
 *
 * Deliberately not here: spaced repetition, item state, persistence. Reps live
 * until the page reloads. The store arrives with its own slice.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TOLERANCES,
  LATENCY_BANDS,
  LATENCY_BAND_LABELS,
  latencyBand,
  runner,
  settledAnswer,
  useGradeRunner,
} from './grade/index.ts';
import type { Rep } from './grade/index.ts';
import { instantiate, inversionTrainer, itemsFor } from './drills/index.ts';
import type { DrillItem } from './drills/index.ts';
import type { InversionParams } from './drills/index.ts';
import {
  INVERSIONS,
  detectChordNames,
  noteNameOf,
  pitchClassName,
  pitchClassOf,
} from './theory.ts';
import type { TriadQuality } from './theory.ts';
import { clusterNoteOns } from './grade/preprocess.ts';
import { session, useAudioSession, useAudioTick } from './audio/index.ts';
import { useMidiState } from './midi.ts';
import { median } from './stats.ts';

/**
 * The bench drills the same template the trainer runs, cast back to its own
 * param type so this screen can filter the pool by quality and inversion. It is
 * the drill's pool, not a copy of it: a chord that could be prompted here and
 * not there would make the bench useless for diagnosing the trainer.
 */
const POOL = itemsFor(inversionTrainer.id) as readonly DrillItem<InversionParams>[];

const ms = (v: number) => `${Math.round(v)}ms`;

/** Flat spellings beside a flat chord symbol, sharps beside a sharp one. */
const spellingOf = (item: DrillItem<InversionParams> | null) => ({
  sharps: item ? inversionTrainer.view(item.params).sharps : true,
});

function Prompt({
  item,
  clusterMs,
}: {
  item: DrillItem<InversionParams> | null;
  clusterMs: number;
}) {
  const r = useGradeRunner();
  // Repaints the settle countdown while an answer is in flight, and supplies
  // the clock reading it counts down from. Display only: the runner's own
  // animation frame is what decides when the rep is actually over.
  const frameTs = useAudioTick(r.state === 'waiting', 60);
  const remaining =
    r.state === 'waiting' && frameTs > 0 ? runner.settleRemainingMs(frameTs) : null;

  if (!item) {
    return (
      <div className="prompt-card idle">
        <p className="muted">
          No prompt. Press <kbd>space</kbd> or hit next to draw one.
        </p>
      </div>
    );
  }

  const view = inversionTrainer.view(item.params);

  return (
    <div className="prompt-card">
      <div className="prompt-symbol">{view.primary}</div>
      <div className="prompt-sub">
        {/* The bench shows the answer with the prompt. It is a debug surface,
            not a drill: nothing here is being measured for learning. */}
        {view.secondary} &middot; {view.answer}
      </div>
      <div className="prompt-state">
        {r.state === 'waiting' && remaining !== null && (
          <span className="settling">
            settling, {ms(remaining)} of {DEFAULT_TOLERANCES.settleMs}ms
          </span>
        )}
        {r.state === 'waiting' && remaining === null && (
          <span className="muted">waiting, chord window {clusterMs}ms</span>
        )}
        {r.state === 'arming' && (
          <span className="muted">timestamping the prompt...</span>
        )}
        {r.state === 'answered' && (
          <span className={r.last?.result.correct ? 'ok' : 'bad'}>
            {r.last?.result.correct ? 'correct' : 'not correct'}
          </span>
        )}
      </div>
    </div>
  );
}

function GradePanel({ rep }: { rep: Rep | null }) {
  if (!rep) {
    return (
      <div className="panel">
        <h2>Grade</h2>
        <p className="note muted">Nothing graded yet this session.</p>
      </div>
    );
  }

  const { result, spec } = rep;
  const band = latencyBand(result.latencyMs);
  const event = result.perEvent[0];
  const played = event?.played ?? [];
  // The same cluster the grader graded, not the last one played: with the
  // default clock this is exactly what `gradeSet` resolved the answer to.
  const answer = settledAnswer(result.raw, spec);
  // Spell the report the way the prompt was spelled. "C#" beside "Db/F" reads
  // as a different note, and detection in particular takes its spelling from
  // whatever it is handed rather than from the music.
  const spelling = spellingOf(itemOf(rep));
  const detected = answer ? detectChordNames(answer.pitches, spelling) : [];
  const pc = (value: number) => pitchClassName(value, spelling);
  const expectedBassPc = spec.expected.events[0]?.bassPc;
  // Only worth saying when it is actually the problem: a wrong note with the
  // right bass should not be told which bass it needed.
  const bassWrong =
    spec.constraints.inversionStrict === true &&
    expectedBassPc !== undefined &&
    answer !== null &&
    pitchClassOf(answer.pitches[0]!) !== expectedBassPc;

  return (
    <div className="panel">
      <h2>
        Grade
        <span className={result.correct ? 'h2-ok' : 'h2-bad'}>
          {result.correct ? 'correct' : (event?.status ?? 'incorrect')}
        </span>
      </h2>
      <dl className="readout">
        <dt>latency</dt>
        <dd className={band === 'not-known' ? 'big bad' : 'big'}>
          {result.latencyMs === null ? 'no answer' : ms(result.latencyMs)}
          {band && <span className={`band ${band}`}>{LATENCY_BAND_LABELS[band]}</span>}
        </dd>
        <dt>score</dt>
        <dd>{result.score.toFixed(2)}</dd>
        <dt>expected</dt>
        <dd>{(event?.expected ?? []).map(pc).join(' ') || '-'}</dd>
        <dt>played</dt>
        <dd>{played.map(pc).join(' ') || 'nothing'}</dd>
        <dt>bass</dt>
        <dd>
          {answer ? noteNameOf(answer.pitches[0]!, spelling) : '-'}
          {bassWrong && <span className="dim"> (needs {pc(expectedBassPc!)})</span>}
        </dd>
        <dt>roll spread</dt>
        <dd>{result.spreadMsMax === null ? '-' : ms(result.spreadMsMax)}</dd>
        <dt>detected</dt>
        <dd>{detected.length > 0 ? detected.join(', ') : '-'}</dd>
      </dl>

      {!result.correct && (
        <ul className="errors">
          {result.noteErrors.wrong.map((w) => (
            <li key={`w${w.expected}`}>
              played <strong>{pc(w.played)}</strong> where{' '}
              <strong>{pc(w.expected)}</strong> was expected
            </li>
          ))}
          {result.noteErrors.missing.map((p) => (
            <li key={`m${p}`}>
              missing <strong>{pc(p)}</strong>
            </li>
          ))}
          {result.noteErrors.extra.map((p) => (
            <li key={`e${p}`}>
              extra <strong>{pc(p)}</strong>
            </li>
          ))}
          {event?.status === 'wrong-inversion' && bassWrong && (
            <li>
              right notes, wrong bass: <strong>{pc(expectedBassPc!)}</strong> has to be
              underneath
            </li>
          )}
        </ul>
      )}

      <p className="note muted">
        Detection is tonal&apos;s, for display only. It ranks a first-inversion major
        triad under its enharmonic twin (E-G-C reads as Em#5 before CM/E), which is why
        grading never uses it.
      </p>
    </div>
  );
}

/**
 * How the rep was carved into chords. This is the panel that answers "why was
 * that marked wrong when I played the right notes": a roll wider than the chord
 * window is more than one cluster, and only the first settled one is the answer.
 */
function ClusterPanel({
  clusterMs,
  spelling,
}: {
  clusterMs: number;
  spelling: { sharps?: boolean };
}) {
  const r = useGradeRunner();
  const events = r.state === 'answered' ? (r.last?.result.raw ?? []) : r.collected();
  const clusters = clusterNoteOns(events, clusterMs);

  return (
    <div className="panel">
      <h2>
        Clusters
        <span className="h2-note">window {clusterMs}ms</span>
      </h2>
      {clusters.length === 0 ? (
        <p className="note muted">Nothing played since the prompt.</p>
      ) : (
        <table className="cc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>notes</th>
              <th>spread</th>
              <th>gap to next</th>
            </tr>
          </thead>
          <tbody>
            {clusters.map((c, i) => {
              const next = clusters[i + 1];
              const gap = next ? next.startTs - c.completeTs : null;
              const settled = gap === null || gap > DEFAULT_TOLERANCES.settleMs;
              return (
                <tr key={c.seqs[0]}>
                  <td className={i === 0 || settled ? 'strong' : undefined}>{i + 1}</td>
                  <td>{c.order.map((p) => noteNameOf(p, spelling)).join(' ')}</td>
                  <td>{ms(c.spreadMs)}</td>
                  <td>{gap === null ? 'settled' : ms(gap)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {clusters.length > 1 && (
        <p className="warn-note">
          More than one cluster. The answer is the first one followed by{' '}
          {DEFAULT_TOLERANCES.settleMs}ms of silence, so a chord placed slower than the
          window is graded in pieces. Widen the window if that is what happened.
        </p>
      )}
    </div>
  );
}

function HistoryPanel() {
  const r = useGradeRunner();
  const reps = r.history;

  const stats = useMemo(() => {
    if (reps.length === 0) return null;
    const correct = reps.filter((rep) => rep.result.correct);
    const latencies = correct
      .map((rep) => rep.result.latencyMs)
      .filter((l): l is number => l !== null);
    const automatic = latencies.filter((l) => l < LATENCY_BANDS.automaticMs).length;
    return {
      reps: reps.length,
      accuracy: correct.length / reps.length,
      medianLatency: latencies.length > 0 ? median(latencies) : null,
      automaticShare: correct.length > 0 ? automatic / correct.length : 0,
    };
  }, [reps]);

  return (
    <div className="panel">
      <h2>
        This session
        <span className="h2-actions">
          <button onClick={() => runner.resetHistory()} disabled={reps.length === 0}>
            Clear
          </button>
        </span>
      </h2>
      {stats === null ? (
        <p className="note muted">No reps yet.</p>
      ) : (
        <>
          <div className="counters">
            <div>
              <span className="num">{stats.reps}</span>
              <span className="lbl">reps</span>
            </div>
            <div>
              <span className="num">{Math.round(stats.accuracy * 100)}%</span>
              <span className="lbl">accuracy</span>
            </div>
            <div>
              <span className="num">
                {stats.medianLatency === null ? '-' : ms(stats.medianLatency)}
              </span>
              <span className="lbl">median latency</span>
            </div>
            <div>
              <span className="num">{Math.round(stats.automaticShare * 100)}%</span>
              <span className="lbl">automatic</span>
            </div>
          </div>
          <ul className="rep-list">
            {[...reps]
              .reverse()
              .slice(0, 12)
              .map((rep, i) => {
                const band = latencyBand(rep.result.latencyMs);
                return (
                  <li key={reps.length - i}>
                    <span className={rep.result.correct ? 'tick ok' : 'tick bad'}>
                      {rep.result.correct ? '✓' : '✕'}
                    </span>
                    <span className="rep-item">{itemOf(rep)?.label ?? '?'}</span>
                    <span className={band ? `band ${band}` : 'band'}>
                      {rep.result.latencyMs === null ? '-' : ms(rep.result.latencyMs)}
                    </span>
                  </li>
                );
              })}
          </ul>
          <p className="note muted">
            Automatic share is over correct reps only, and is the same statistic the tree
            uses to call a deck complete: {'>'}
            {Math.round(0.85 * 100)}% of items under {LATENCY_BANDS.automaticMs}ms.
          </p>
        </>
      )}
    </div>
  );
}

/** The pool item a graded rep came from, by its stable id. */
function itemOf(rep: Rep): DrillItem<InversionParams> | null {
  return POOL.find((i) => i.itemId === rep.spec.itemId) ?? null;
}

export default function GraderScreen() {
  const audioSession = useAudioSession();
  const midiState = useMidiState();
  const r = useGradeRunner();

  const [qualities, setQualities] = useState<TriadQuality[]>(['maj']);
  const [inversions, setInversions] = useState<number[]>([1, 2]);
  const [clusterMs, setClusterMs] = useState(DEFAULT_TOLERANCES.chordClusterMs);
  const [item, setItem] = useState<DrillItem<InversionParams> | null>(null);
  const lastItem = useRef<string | null>(null);

  const pool = useMemo(
    () =>
      POOL.filter(
        (i) =>
          qualities.includes(i.params.quality) && inversions.includes(i.params.inversion)
      ),
    [qualities, inversions]
  );

  const next = useCallback(() => {
    if (pool.length === 0) return;
    let pick = pool[Math.floor(Math.random() * pool.length)]!;
    // One retry is enough to stop an immediate repeat without pretending this
    // is scheduling. Real selection is the trainer's queue, and after that the
    // scheduler's softmax over priority.
    if (pool.length > 1 && pick.itemId === lastItem.current) {
      pick = pool[Math.floor(Math.random() * pool.length)]!;
    }
    lastItem.current = pick.itemId;
    setItem(pick);
    runner.arm(instantiate(inversionTrainer, pick, { chordClusterMs: clusterMs }));
  }, [pool, clusterMs]);

  // Space draws the next prompt. A drill that needs the mouse between every rep
  // is a drill that gets used once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (r.state === 'waiting') runner.submit();
      else next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, r.state]);

  useEffect(() => () => runner.cancel(), []);

  const ready = midiState.status === 'ready';

  return (
    <div className="screen grader">
      {!ready && (
        <div className="banner start">
          <div>
            <strong>MIDI is not enabled.</strong> The bench grades what the keyboard
            sends, so it needs the same permission the inspector does. Starting audio
            enables both and gives the prompt something to play through.
          </div>
          <button className="primary" onClick={() => void session.start()}>
            Start audio and MIDI
          </button>
        </div>
      )}

      <Prompt item={item} clusterMs={clusterMs} />

      <div className="toolbar">
        <button className="primary" onClick={next} disabled={pool.length === 0}>
          Next prompt
        </button>
        <button onClick={() => runner.submit()} disabled={r.state !== 'waiting'}>
          Submit now
        </button>
        <button
          onClick={() =>
            item && session.play(inversionTrainer.view(item.params).audition)
          }
          disabled={!item || audioSession.status !== 'ready'}
          title="Play the prompted chord through the app piano"
        >
          Hear it
        </button>
        <label className="grow">
          chord window
          <input
            type="number"
            min={20}
            max={600}
            step={10}
            value={clusterMs}
            onChange={(e) => setClusterMs(Number(e.target.value))}
          />
          ms
        </label>
      </div>

      <div className="toolbar">
        <span className="control-label">quality</span>
        <Toggles
          options={[
            { value: 'maj' as TriadQuality, label: 'major' },
            { value: 'min' as TriadQuality, label: 'minor' },
          ]}
          selected={qualities}
          onChange={setQualities}
        />
        <span className="control-label">inversion</span>
        <Toggles
          options={INVERSIONS.map((i) => ({
            value: i as number,
            label: ['root', '1st', '2nd'][i]!,
          }))}
          selected={inversions}
          onChange={setInversions}
        />
        <span className="muted">{pool.length} items</span>
      </div>

      <div className="panels">
        <GradePanel rep={r.state === 'answered' ? r.last : null} />
        <ClusterPanel clusterMs={clusterMs} spelling={spellingOf(item)} />
        <HistoryPanel />
      </div>

      <p className="note muted">
        Latency runs from the prompt being painted to the last note of the chord going
        down, both read from MIDI timestamps, so a slow frame delays the feedback and
        cannot change the number. Space submits an answer, then draws the next prompt.
        Prompts come from the inversion trainer&apos;s own item pool, so an item that
        misbehaves here is the same item, with the same id, that misbehaved in the{' '}
        <a href="#/train">trainer</a>. Nothing is saved: reps last until the page reloads.
      </p>
    </div>
  );
}

/** A multi-select of the same shape as the segmented control elsewhere. */
function Toggles<T extends string | number>({
  options,
  selected,
  onChange,
}: {
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <span className="segmented">
      {options.map((o) => {
        const active = selected.includes(o.value);
        return (
          <button
            key={String(o.value)}
            className={active ? 'active' : undefined}
            onClick={() => {
              const next = active
                ? selected.filter((v) => v !== o.value)
                : [...selected, o.value];
              // Never let the pool empty: the last selection stays on.
              if (next.length > 0) onChange(next);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
