/**
 * The chord HUD. CLAUDE.md's second V1 drill, and the one that never asks for
 * anything.
 *
 * Everything else in this app is a transaction: it prompts, you answer, it
 * grades, it schedules. This is the opposite and session-generator.md section 8
 * is explicit about why - "his existing habit becomes the scheduler's
 * reconnaissance; the app earns value from him **before** demanding anything".
 * So there is no prompt, no score, no correct and no wrong on this screen, and
 * adding any of them would turn the one part of the app that costs the user
 * nothing into another thing to be judged by.
 *
 * What it does show is what it heard: the chord under the hands, named; how long
 * the hand took to get there; and which items that told it something about. The
 * last panel is the honest disclosure - the app is learning from this playing,
 * and it says exactly what it learned.
 *
 * Two rules the screen keeps, both from architecture.md section 2:
 *
 *  - **`Chord.detect` names, and never decides.** The names on screen are
 *    tonal's ranked candidates, which are heuristic, and the item a chord is
 *    attributed to comes from `buildExpected` instead. Nothing detection says
 *    reaches the store.
 *  - **Spelling is an app choice, not an observation.** MIDI carries pitch
 *    numbers, and the same three keys are `Cm/Eb` or `Cm/D#` depending only on
 *    what the namer was told to call them. Hence the toggle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { midi, useHeldNotes, useMidiState } from './midi.ts';
import { detectChordNames, noteNameOf } from './theory.ts';
import { store, useProgressStore } from './store/index.ts';
import { ChordWatcher, Harvest, HARVEST_MIN_OBSERVATIONS } from './hud/index.ts';
import type { ChordChange, HarvestRow } from './hud/index.ts';
import { attributableShapes } from './hud/index.ts';
import { latencyBand, latencyBandLabel } from './grade/index.ts';
import { session, useAudioSession } from './audio/index.ts';

const ms = (v: number) => `${Math.round(v)}ms`;

/** How many chord changes stay on screen. Enough to see a chart go by. */
const LOG_LENGTH = 24;

interface LoggedChange {
  key: number;
  names: string[];
  notes: string;
  itemLabel: string | null;
  changeLatencyMs: number | null;
  harvested: boolean;
}

/**
 * The whole HUD loop: fold the MIDI stream into chords, and hand the slow ones
 * to the harvest.
 *
 * The settle deadline is polled on animation frames rather than by a timer, like
 * every other wait in this app: `setInterval` is banned for anything musical
 * (CLAUDE.md) and Chrome throttles timers to one a second in a background tab,
 * which would turn a 300ms settle into a one-second one. Nothing measured comes
 * from the frame clock - a chord's times are its own note timestamps - so a late
 * frame delays a name appearing and cannot move a number.
 */
function useChordHud(sharps: boolean, harvesting: boolean) {
  const watcher = useRef(new ChordWatcher());
  const harvest = useRef(new Harvest());
  const counter = useRef(0);
  const [log, setLog] = useState<LoggedChange[]>([]);
  const [rows, setRows] = useState<HarvestRow[]>([]);
  const [nudges, setNudges] = useState(0);

  // Read through a ref so the animation frame loop is not restarted, and the
  // watcher not rebuilt, every time one of these changes.
  const options = useRef({ sharps, harvesting });
  options.current = { sharps, harvesting };

  useEffect(() => {
    const w = watcher.current;
    const unsubscribe = midi.subscribe((event) => w.handle(event));

    const record = (change: ChordChange) => {
      const { sharps: useSharps, harvesting: harvestOn } = options.current;
      const item = change.item;
      let harvested = false;

      // section 8: only a change latency we could actually see, only when the
      // chord is an item we know, and only when the user has the harvest on.
      if (harvestOn && item && change.changeLatencyMs !== null) {
        const nudge = harvest.current.observe(
          item.itemId,
          item.label,
          change.changeLatencyMs
        );
        setRows(harvest.current.rows());
        if (nudge) {
          harvested = true;
          setNudges((n) => n + 1);
          void store.harvestLatency(nudge.itemId, nudge.medianMs);
        }
      }

      counter.current += 1;
      setLog((previous) =>
        [
          {
            key: counter.current,
            names: detectChordNames(change.chord.pitches, { sharps: useSharps }),
            notes: change.chord.pitches
              .map((p) => noteNameOf(p, { sharps: useSharps }))
              .join(' '),
            itemLabel: item?.label ?? null,
            changeLatencyMs: change.changeLatencyMs,
            harvested,
          },
          ...previous,
        ].slice(0, LOG_LENGTH)
      );
    };

    let frame = requestAnimationFrame(function tick(nowMs) {
      frame = requestAnimationFrame(tick);
      const change = w.poll(nowMs);
      if (change) record(change);
    });

    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, []);

  const clear = useCallback(() => {
    watcher.current.reset();
    harvest.current.reset();
    setLog([]);
    setRows([]);
    setNudges(0);
  }, []);

  return { log, rows, nudges, clear };
}

/** What is under the hands, right now. The only thing on screen that moves. */
function NowSounding({ sharps }: { sharps: boolean }) {
  const held = useHeldNotes();
  const names = detectChordNames(held, { sharps });

  return (
    <div className="prompt-card hud-now">
      <div className="prompt-symbol">
        {names[0] ?? (held.length === 0 ? '-' : `${held.length} notes`)}
      </div>
      <div className="prompt-sub">
        {held.length === 0
          ? 'nothing sounding'
          : held.map((p) => noteNameOf(p, { sharps })).join(' ')}
      </div>
      <div className="prompt-state">
        {names.length > 1 ? (
          <span className="muted">also reads as {names.slice(1, 4).join(', ')}</span>
        ) : (
          <span className="muted">named by tonal, never graded</span>
        )}
      </div>
    </div>
  );
}

function ChangeLog({ log }: { log: readonly LoggedChange[] }) {
  return (
    <div className="panel wide">
      <h2>
        What you played
        <span className="h2-note">newest first</span>
      </h2>
      {log.length === 0 ? (
        <p className="note muted">
          Play a chord. Three notes held still for a moment is a chord; the app names it
          and times how long the hand took to get there.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="cc-table">
            <thead>
              <tr>
                <th>chord</th>
                <th>notes</th>
                <th>change</th>
                <th>item</th>
              </tr>
            </thead>
            <tbody>
              {log.map((row) => {
                const band = latencyBand(row.changeLatencyMs);
                return (
                  <tr key={row.key}>
                    <td className="strong">{row.names[0] ?? '?'}</td>
                    <td className="mono">{row.notes}</td>
                    <td className={band ? `band-text ${band}` : 'muted'}>
                      {row.changeLatencyMs === null
                        ? 'held through'
                        : `${ms(row.changeLatencyMs)} ${latencyBandLabel(band!)}`}
                    </td>
                    <td>
                      {row.itemLabel === null ? (
                        <span className="muted">not in a deck</span>
                      ) : (
                        <>
                          {row.itemLabel}
                          {row.harvested && <span className="flag">nudged</span>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="note muted">
        &quot;Change&quot; is the gap from the previous chord coming apart to this one
        being complete: the hand in transit. A chord you held through the change has no
        gap to measure and says so, which is the blind spot in this number and the reason
        section 8 calls it low-trust.
      </p>
    </div>
  );
}

function HarvestPanel({
  rows,
  nudges,
  harvesting,
}: {
  rows: readonly HarvestRow[];
  nudges: number;
  harvesting: boolean;
}) {
  return (
    <div className="panel">
      <h2>
        What this told the scheduler
        <span className="h2-note">latency only, never scheduling</span>
      </h2>
      {rows.length === 0 ? (
        <p className="note muted">
          {harvesting
            ? `Nothing yet. A chord has to be seen ${HARVEST_MIN_OBSERVATIONS} times before one slow change counts as a slow chord.`
            : 'Harvesting is off. The HUD still names what you play and nothing is written down.'}
        </p>
      ) : (
        <>
          <ul className="rep-list">
            {rows.slice(0, 10).map((row) => {
              const band = latencyBand(row.medianMs);
              return (
                <li key={row.itemId}>
                  <span className="rep-item">{row.label}</span>
                  <span className="muted">{row.observations}x</span>
                  <span className={band ? `band ${band}` : 'band'}>
                    {ms(row.medianMs)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="note muted">
            {nudges} nudge{nudges === 1 ? '' : 's'} written. Only the median goes in, only
            if it is slower than what the item already claims, and only to{' '}
            <code>latEMA</code>. No rep is logged, nothing becomes due, and nothing counts
            against today&apos;s new-item allowance.
          </p>
        </>
      )}
    </div>
  );
}

export default function HudScreen() {
  const midiState = useMidiState();
  const audio = useAudioSession();
  const s = useProgressStore();
  const [sharps, setSharps] = useState(true);
  const [harvesting, setHarvesting] = useState(true);
  const { log, rows, nudges, clear } = useChordHud(sharps, harvesting);

  useEffect(() => {
    void store.load();
  }, []);

  const ready = midiState.status === 'ready';

  return (
    <div className="screen hud">
      {!ready && (
        <div className="banner start">
          <div>
            <strong>MIDI is not enabled.</strong> The HUD watches the keyboard and asks
            for nothing. Starting audio enables both and gives you the app piano to play
            through, which is the point: the keyboard&apos;s own volume is meant to be at
            zero.
          </div>
          <button className="primary" onClick={() => void session.start()}>
            Start audio and MIDI
          </button>
        </div>
      )}

      <div className="banner">
        <div>
          <strong>Free play.</strong> No prompts, nothing graded, nothing to get wrong.
          Play a chart the way you already do; the app names the chords and times the
          changes. Chords it recognises and finds you consistently slow on get a slower
          starting assumption in the deck, and that is the whole of what it does with
          this.
        </div>
      </div>

      <NowSounding sharps={sharps} />

      <div className="toolbar">
        <div className="segmented">
          <button
            className={sharps ? 'active' : undefined}
            onClick={() => setSharps(true)}
          >
            sharps
          </button>
          <button
            className={!sharps ? 'active' : undefined}
            onClick={() => setSharps(false)}
          >
            flats
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            checked={harvesting}
            onChange={(e) => setHarvesting(e.target.checked)}
          />
          harvest latencies
        </label>
        <button onClick={clear}>Clear</button>
        <span className="grow" />
        <span className="muted">
          {attributableShapes()} chords recognised
          {audio.status === 'ready'
            ? ''
            : ' - audio is off, so you are hearing the keyboard'}
        </span>
      </div>

      <ChangeLog log={log} />

      <div className="panels">
        <HarvestPanel rows={rows} nudges={nudges} harvesting={harvesting} />
        <div className="panel">
          <h2>Why this is not a drill</h2>
          <p className="note muted">
            It has no items, no prompts and no grader, so there is nothing for the drill
            schema to hold. What it has is a mode: the app watching instead of asking. A
            rep here would be a rep you never agreed to, which is why none is written - a
            harvested chord updates one number, <code>latEMA</code>, with a tenth of the
            weight a real answer carries.
          </p>
          <p className="note muted">
            Attribution is deterministic and never uses chord detection. The names above
            are tonal&apos;s best guesses and are for your eyes; which item a chord counts
            as comes from the same expected-pitch calculation the grader uses. The two
            never touch.
          </p>
          <p className="note muted">
            {s.itemState.size} items tracked. The decks themselves are on{' '}
            <a href="#/train">train</a>, and what all of this adds up to is on{' '}
            <a href="#/progress">progress</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
