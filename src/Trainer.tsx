/**
 * The inversion trainer. V1 drill 1, and the first screen in this app that is
 * for practising rather than for proving something works.
 *
 * The whole design serves one number. He can derive an inversion in about four
 * seconds and the target is under 1.2, so every element here either shows a
 * prompt, gets out of the way, or reports latency. There is no mouse in the
 * loop: a correct answer advances by itself and space covers everything else.
 *
 * Two ways in. **Today's session** is the scheduler: the active set picks the
 * nodes, spaced repetition picks the items, and softmax picks the order. **Free
 * practice** is a deck chosen by hand in a shuffled cycle, which is what slice 4
 * built and is still the right thing when the user wants to hammer one deck.
 * Both persist, and both feed the same SRS.
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
import type { DrillItem, PracticeMode, PracticeRep, PromptView } from './drills/index.ts';
import { store, useProgressStore } from './store/index.ts';
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
  idleHint,
}: {
  item: DrillItem | null;
  view: PromptView | null;
  last: PracticeRep | null;
  idleHint: React.ReactNode;
}) {
  const r = useGradeRunner();
  const graded = r.state === 'answered' && last !== null && last.item === item;
  const result = graded && last ? last.rep.result : null;
  const band = latencyBand(result?.latencyMs ?? null);

  if (!item || !view) {
    return (
      <div className="prompt-card idle">
        <p className="muted">{idleHint}</p>
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
            Automatic share is over correct reps only, and over this session only.
            {target !== null && (
              <>
                {' '}
                The tree calls this deck complete at {Math.round(target * 100)}% of items
                under {LATENCY_BANDS.automaticMs}ms sustained across sessions, which is
                the number on <a href="#/progress">progress</a>.
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

/**
 * Why the current item is on screen. Small, and next to the prompt rather than
 * in a panel: the one question a scheduler has to be able to answer at any
 * moment is "why this?", and an app that cannot answer it stops being trusted.
 */
function ReasonTag({ reason }: { reason: string | null }) {
  if (!reason) return null;
  const text =
    reason === 'new'
      ? 'new item'
      : reason === 'learning'
        ? 'still learning'
        : 'due for review';
  return <span className={`reason ${reason}`}>{text}</span>;
}

export default function TrainerScreen() {
  const p = usePractice();
  const r = useGradeRunner();
  const audio = useAudioSession();
  const midiState = useMidiState();
  const s = useProgressStore();

  const [mode, setMode] = useState<PracticeMode>('scheduled');
  const [deck, setDeck] = useState<readonly string[]>(practice.nodeIds);
  const running = p.status === 'running';

  useEffect(() => {
    void store.load();
  }, []);

  const begin = useCallback(() => {
    if (mode === 'scheduled') void practice.startScheduled();
    else void practice.start(deck);
  }, [mode, deck]);
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
      begin();
      return;
    }
    if (r.state === 'waiting') {
      // Grade what is there now. With nothing played this is the honest miss.
      runner.submit();
      return;
    }
    practice.next();
  }, [running, begin, r.state]);

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

      {p.returnMode !== 'normal' && running && p.mode === 'scheduled' && (
        <div className="banner">
          <div>
            {p.returnMode === 're-entry' ? (
              <>
                <strong>Re-entry session.</strong> Ten minutes, your strongest items only,
                nothing new. The point of coming back is coming back.
              </>
            ) : (
              <>
                <strong>Easing back in.</strong> Shorter session, no new material today.
              </>
            )}
          </div>
        </div>
      )}

      <div className="toolbar">
        <div className="segmented">
          <button
            className={mode === 'scheduled' ? 'active' : undefined}
            disabled={running}
            onClick={() => setMode('scheduled')}
            title="The scheduler picks: what is due, in softmax order, with new items from the daily faucet."
          >
            Today&apos;s session
          </button>
          <button
            className={mode === 'free' ? 'active' : undefined}
            disabled={running}
            onClick={() => setMode('free')}
            title="A deck you pick, in a shuffled cycle. Still logged, still schedules."
          >
            Free practice
          </button>
        </div>
        <span className="grow" />
        {running ? (
          <button onClick={() => practice.end()}>End session</button>
        ) : (
          <button
            className="primary"
            onClick={begin}
            disabled={p.status === 'starting' || (mode === 'free' && deck.length === 0)}
          >
            {p.status === 'starting' ? 'starting...' : 'Start'}
          </button>
        )}
      </div>

      {mode === 'free' && (
        <div className="toolbar">
          <DeckPicker selected={deck} onChange={setDeck} disabled={running} />
        </div>
      )}

      {p.endedBecause === 'exhausted' && (
        <div className="banner ok">
          <div>
            <strong>That is everything due today.</strong> The rest comes back on its own
            date, and the new-item faucet refills tomorrow. Nothing is owed and nothing is
            behind. Free practice is there if you want more.
          </div>
        </div>
      )}

      <PromptCard
        item={item}
        view={view}
        last={graded ? last : null}
        idleHint={
          mode === 'scheduled' ? (
            <>
              Press <kbd>space</kbd> for today&apos;s session.
            </>
          ) : (
            <>
              Pick a deck and press <kbd>space</kbd> to start.
            </>
          )
        }
      />
      {running && p.mode === 'scheduled' && <ReasonTag reason={p.reason} />}

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
          {running && p.mode === 'scheduled'
            ? `${p.dueCount} due, ${p.newItemsLeft} new left`
            : running
              ? `${p.remainingInPass} left of ${p.deckSize} this pass`
              : mode === 'free'
                ? `${pending} items selected`
                : `${s.dueNow()} due, ${s.newItemsLeftToday()} new left today`}
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
        number. Any octave counts; the bass note does not. Correctness only decides
        whether the latency counts: under 1.2s schedules the item further out than 4s
        does, even though both are right. Everything here is saved, and{' '}
        <a href="#/progress">progress</a> is where it adds up.
      </p>
    </div>
  );
}
