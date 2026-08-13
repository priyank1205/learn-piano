/**
 * The inversion trainer. V1 drill 1, and the first screen in this app that is
 * for practising rather than for proving something works.
 *
 * The whole design serves one number. He can derive an inversion in about four
 * seconds and the target is under 1.2, so every element here either shows a
 * prompt, gets out of the way, or reports latency. There is no mouse in the
 * loop: a correct answer advances by itself and space covers everything else.
 *
 * What this is not, yet: the deck is chosen by hand and nothing is saved, so
 * there is no spaced repetition, no due date and no mastery. Those need the
 * store, which is the next slice. The order inside a session is a shuffled
 * cycle with missed items requeued, which is the part of session-generator.md
 * that does not need history to exist.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DWELL_MS,
  itemsForNode,
  itemsForNodes,
  practice,
  summarise,
  templateForItem,
  usePractice,
} from './drills/index.ts';
import type { DrillItem, PracticeRep, PromptView } from './drills/index.ts';
import {
  LATENCY_BANDS,
  latencyBand,
  latencyBandLabel,
  runner,
  useGradeRunner,
} from './grade/index.ts';
import { deckFluencyOf, nodeById, nodeName } from './tree.ts';
import { pitchClassName } from './theory.ts';
import { session, useAudioSession } from './audio/index.ts';
import { useMidiState } from './midi.ts';

/** The nodes the inversion trainer can drill, in the tree's dependency order. */
const DECK_NODES = ['kt-triads-root', 'kt-inv-maj-triads', 'kt-inv-min-triads'] as const;

const ms = (v: number) => `${Math.round(v)}ms`;

function DeckPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="deck-picker">
      {DECK_NODES.map((id) => {
        const node = nodeById(id);
        const active = selected.includes(id);
        const count = itemsForNode(id).length;
        return (
          <button
            key={id}
            className={active ? 'deck active' : 'deck'}
            disabled={disabled}
            onClick={() =>
              onChange(active ? selected.filter((n) => n !== id) : [...selected, id])
            }
            title={node?.desc}
          >
            <span className="deck-name">{nodeName(id)}</span>
            <span className="deck-count">{count} items</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The prompt. Deliberately the only thing on screen that moves while the clock
 * is running: the answer, the errors and the stats all appear after the rep is
 * graded, never during it.
 */
function PromptCard({
  item,
  view,
  last,
}: {
  item: DrillItem | null;
  view: PromptView | null;
  last: PracticeRep | null;
}) {
  const r = useGradeRunner();
  const graded = r.state === 'answered' && last !== null && last.item === item;
  const result = graded && last ? last.rep.result : null;
  const band = latencyBand(result?.latencyMs ?? null);

  if (!item || !view) {
    return (
      <div className="prompt-card idle">
        <p className="muted">
          Pick a deck and press <kbd>space</kbd> to start.
        </p>
      </div>
    );
  }

  return (
    <div className={`prompt-card${result ? (result.correct ? ' ok' : ' bad') : ''}`}>
      <div className="prompt-symbol">{view.primary}</div>
      <div className="prompt-sub">{view.secondary}</div>
      <div className="prompt-state">
        {result === null && <span className="muted">waiting</span>}
        {result !== null && result.correct && (
          <span className="ok">
            {result.latencyMs === null ? 'correct' : ms(result.latencyMs)}
            {band && <span className={`band ${band}`}>{latencyBandLabel(band)}</span>}
          </span>
        )}
        {result !== null && !result.correct && <span className="bad">{view.answer}</span>}
      </div>
    </div>
  );
}

/** What went wrong, in pitch classes, because the drill grades pitch classes. */
function MissDetail({ rep, view }: { rep: PracticeRep; view: PromptView }) {
  const { result } = rep.rep;
  const pc = (value: number) => pitchClassName(value, { sharps: view.sharps });
  const event = result.perEvent[0];

  return (
    <ul className="errors">
      {event?.status === 'wrong-inversion' && (
        <li>
          right notes, wrong bass: <strong>{view.answer.split(' ')[0]}</strong> has to be
          underneath
        </li>
      )}
      {result.noteErrors.wrong.map((w) => (
        <li key={`w${w.expected}`}>
          played <strong>{pc(w.played)}</strong> where <strong>{pc(w.expected)}</strong>{' '}
          was expected
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
    </ul>
  );
}

function SessionPanel({
  reps,
  nodeIds,
}: {
  reps: readonly PracticeRep[];
  nodeIds: readonly string[];
}) {
  const stats = useMemo(() => summarise(reps), [reps]);
  // Every V1 deck is a deckFluency node and they all want the same share; show
  // the strictest of the selected decks rather than picking one arbitrarily.
  const target = useMemo(() => {
    const shares = nodeIds
      .map((id) => deckFluencyOf(id)?.automaticShare)
      .filter((s): s is number => s !== undefined);
    return shares.length > 0 ? Math.max(...shares) : null;
  }, [nodeIds]);

  return (
    <div className="panel">
      <h2>This session</h2>
      {stats.reps === 0 ? (
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
                {stats.medianLatencyMs === null ? '-' : ms(stats.medianLatencyMs)}
              </span>
              <span className="lbl">median latency</span>
            </div>
            <div>
              <span className="num">{Math.round(stats.automaticShare * 100)}%</span>
              <span className="lbl">automatic</span>
            </div>
          </div>
          <p className="note muted">
            Automatic share is over correct reps only.
            {target !== null && (
              <>
                {' '}
                The tree calls this deck complete at {Math.round(target * 100)}% of items
                under {LATENCY_BANDS.automaticMs}ms, sustained, which needs the history
                the store slice will keep.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/** Slowest and least reliable first: the list of what to actually work on. */
function WorkListPanel({ reps }: { reps: readonly PracticeRep[] }) {
  const stats = useMemo(() => summarise(reps), [reps]);
  const rows = stats.byItem.slice(0, 8);

  return (
    <div className="panel">
      <h2>
        Needs work
        <span className="h2-note">slowest first</span>
      </h2>
      {rows.length === 0 ? (
        <p className="note muted">Nothing graded yet.</p>
      ) : (
        <table className="cc-table">
          <thead>
            <tr>
              <th>item</th>
              <th>reps</th>
              <th>right</th>
              <th>median</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const band = latencyBand(row.medianLatencyMs);
              return (
                <tr key={row.item.itemId}>
                  <td className="strong">{row.item.label}</td>
                  <td>{row.reps}</td>
                  <td className={row.correct < row.reps ? 'miss' : undefined}>
                    {row.correct}
                  </td>
                  <td className={band ? `band-text ${band}` : undefined}>
                    {row.medianLatencyMs === null ? '-' : ms(row.medianLatencyMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HistoryPanel({ reps }: { reps: readonly PracticeRep[] }) {
  return (
    <div className="panel">
      <h2>Reps</h2>
      {reps.length === 0 ? (
        <p className="note muted">Nothing yet.</p>
      ) : (
        <ul className="rep-list">
          {[...reps]
            .reverse()
            .slice(0, 14)
            .map((r, i) => {
              const band = latencyBand(r.rep.result.latencyMs);
              return (
                <li key={reps.length - i}>
                  <span className={r.rep.result.correct ? 'tick ok' : 'tick bad'}>
                    {r.rep.result.correct ? '✓' : '✕'}
                  </span>
                  <span className="rep-item">{r.item.label}</span>
                  <span className={band ? `band ${band}` : 'band'}>
                    {r.rep.result.latencyMs === null ? '-' : ms(r.rep.result.latencyMs)}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

export default function TrainerScreen() {
  const p = usePractice();
  const r = useGradeRunner();
  const audio = useAudioSession();
  const midiState = useMidiState();

  const [deck, setDeck] = useState<readonly string[]>(practice.nodeIds);
  const running = p.status === 'running';
  const item = p.current;
  const view = useMemo(
    () => (item ? templateForItem(item).view(item.params) : null),
    [item]
  );
  const last = p.reps.length > 0 ? p.reps[p.reps.length - 1]! : null;
  const graded = r.state === 'answered' && last !== null && last.item === item;
  const missed = graded && last !== null && !last.rep.result.correct;
  // Before a session exists there is no queue to ask, so the size of the deck
  // about to be started comes from the selection instead.
  const pending = useMemo(() => itemsForNodes(deck).length, [deck]);

  const hear = useCallback(() => {
    if (view && audio.status === 'ready') session.play(view.audition);
  }, [view, audio.status]);

  /**
   * One key does everything: start, submit, continue. A drill that needs a
   * different key per state is a drill that gets used once.
   */
  const advance = useCallback(() => {
    if (!running) {
      practice.start(deck);
      return;
    }
    if (r.state === 'waiting') {
      // Grade what is there now. With nothing played this is the honest miss.
      runner.submit();
      return;
    }
    practice.next();
  }, [running, deck, r.state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        advance();
      } else if (e.key === 'h') {
        e.preventDefault();
        hear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, hear]);

  // Leaving the screen ends the session: the loop arms the shared grade runner,
  // and an armed runner behind an unmounted screen is a rep nobody can see.
  useEffect(() => () => practice.end(), []);

  const ready = midiState.status === 'ready';

  return (
    <div className="screen trainer">
      {!ready && (
        <div className="banner start">
          <div>
            <strong>MIDI is not enabled.</strong> The trainer grades what the keyboard
            sends. Starting audio enables both and gives the prompt something to play
            through, which matters here: the keyboard's own volume is meant to be at zero.
          </div>
          <button className="primary" onClick={() => void session.start()}>
            Start audio and MIDI
          </button>
        </div>
      )}

      <div className="toolbar">
        <DeckPicker selected={deck} onChange={setDeck} disabled={running} />
        <span className="grow" />
        {running ? (
          <button onClick={() => practice.end()}>End session</button>
        ) : (
          <button
            className="primary"
            onClick={() => practice.start(deck)}
            disabled={deck.length === 0}
          >
            Start
          </button>
        )}
      </div>

      <PromptCard item={item} view={view} last={graded ? last : null} />

      {missed && last && view && (
        <div className="miss-card">
          <MissDetail rep={last} view={view} />
          <div className="miss-actions">
            <button onClick={hear} disabled={audio.status !== 'ready'}>
              Hear it <kbd>h</kbd>
            </button>
            <button className="primary" onClick={() => practice.next()}>
              Continue <kbd>space</kbd>
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <button onClick={advance} disabled={!running && deck.length === 0}>
          {!running ? 'Start' : r.state === 'waiting' ? 'I do not know' : 'Next'}
        </button>
        <button onClick={hear} disabled={!view || audio.status !== 'ready'}>
          Hear it
        </button>
        <label>
          <input
            type="checkbox"
            checked={p.autoAdvance}
            onChange={(e) => practice.setAutoAdvance(e.target.checked)}
          />
          auto-advance
        </label>
        <label>
          after
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            value={p.dwellMs}
            disabled={!p.autoAdvance}
            onChange={(e) =>
              practice.setDwellMs(Number(e.target.value) || DEFAULT_DWELL_MS)
            }
          />
          ms
        </label>
        <span className="grow" />
        <span className="muted">
          {running
            ? `${p.remainingInPass} left of ${p.deckSize} this pass`
            : `${pending} items selected`}
        </span>
      </div>

      <div className="panels">
        <SessionPanel reps={p.reps} nodeIds={p.nodeIds} />
        <WorkListPanel reps={p.reps} />
        <HistoryPanel reps={p.reps} />
      </div>

      <p className="note muted">
        Latency runs from the prompt being painted to the last note of the chord going
        down, both read from MIDI timestamps, so a slow frame cannot flatter or spoil a
        number. Any octave counts; the bass note does not. Missed items come back later in
        the same session. Nothing is saved: reps last until the page reloads, which is
        what the store slice fixes.
      </p>
    </div>
  );
}
