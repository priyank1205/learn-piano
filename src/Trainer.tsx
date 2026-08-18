/**
 * The practice screen. Everything with a drill behind it runs here.
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
 *
 * Slice 6 is where "drills are data" stopped being a claim. This screen now
 * serves four drills of three different shapes, and it knows the id of none of
 * them: what it renders comes from the template's `view`, and how it reports a
 * result comes from the shape of the `GradeResult`. A rep with a latency is
 * reported in milliseconds and a band; a rep with timing statistics is reported
 * as a pass against them. The deck list is the registry's, not a constant. If a
 * seventh drill needs an edit here, the schema was wrong.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DWELL_MS,
  drillableNodeIds,
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
  OVERLAP_CLASSES,
  OVERLAP_CLASS_LABELS,
  latencyBand,
  latencyBandLabel,
  runner,
  summariseOverlap,
  useGradeRunner,
  withTolerances,
} from './grade/index.ts';
import type { GradeResult, OverlapSummary } from './grade/index.ts';
import { NODES, deckFluencyOf, nodeById, nodeName } from './tree.ts';
import { noteNameOf, pitchClassName } from './theory.ts';
import { beatIndexAt, session, useAudioSession, useAudioTick } from './audio/index.ts';
import { useMidiState } from './midi.ts';

/**
 * Every node some registered drill can exercise, in the tree's own order. Read
 * from the registry rather than listed, so a drill that lands is a deck that
 * appears.
 */
const DECK_NODES: readonly string[] = NODES.map((n) => n.id).filter((id) =>
  drillableNodeIds().includes(id)
);

const ms = (v: number) => `${Math.round(v)}ms`;

/**
 * "tempoBpm present => timed grading" (architecture.md section 2).
 *
 * Read from the spec rather than from the result, which is a distinction with
 * teeth: a run where nothing was played has no timing statistics either, and a
 * result-shaped test would report it as eight identical missing notes instead of
 * as a run that did not happen.
 */
const isTimed = (rep: PracticeRep): boolean =>
  rep.rep.spec.expected.tempoBpm !== undefined;

const countErrors = (result: GradeResult): number =>
  result.noteErrors.missing.length +
  result.noteErrors.extra.length +
  result.noteErrors.wrong.length;

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The overlaps of one rep, against the band it was graded under.
 *
 * Read off the result and the spec rather than off the drill: a rep that
 * measured note overlap is a legato rep, whatever template produced it, and the
 * band is on the spec because that is where the calibration was merged in.
 */
const overlapOf = (rep: PracticeRep): OverlapSummary | null => {
  const byHand = rep.rep.result.noteOverlapMs;
  return byHand === null
    ? null
    : summariseOverlap(byHand, withTolerances(rep.rep.spec.grading.tolerances));
};

/**
 * How a note is named back to the user: as a pitch class when the drill graded
 * pitch classes, as a note when it graded notes. Reporting "you played C where C
 * was expected" after a missed octave in the ear drill would be true, useless
 * and infuriating.
 */
const nameFor = (octaveEquivalent: boolean, sharps: boolean) => (value: number) =>
  octaveEquivalent ? pitchClassName(value, { sharps }) : noteNameOf(value, { sharps });

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
 * The beat, while a timed rep runs.
 *
 * Read from the clock on animation frames rather than counted by a Transport
 * callback, for the reason `audio/transport.ts` gives: with no look-ahead, Tone
 * dispatches its callbacks late, and a counter that is late is not the beat. The
 * count-in counts down, then a dot fills per beat.
 */
function PulseBar() {
  const audio = useAudioSession();
  const plan = audio.pulse;
  const tick = useAudioTick(plan !== null, 40);
  if (!plan) return null;

  const beat = tick > 0 ? beatIndexAt(plan, tick) : -plan.countInBeats;
  if (beat < 0) {
    return (
      <div className="pulse-bar count-in">
        <span className="count">{-beat}</span>
        <span className="muted">counting in</span>
      </div>
    );
  }

  return (
    <div className="pulse-bar">
      {Array.from({ length: plan.beats }, (_, i) => (
        <span
          key={i}
          className={i < beat ? 'beat done' : i === beat ? 'beat now' : 'beat'}
        />
      ))}
      <span className="muted">
        beat {Math.min(beat + 1, plan.beats)} of {plan.beats}
      </span>
    </div>
  );
}

/** What one graded rep is worth saying, in the terms that rep was measured in. */
function ResultLine({
  rep,
  view,
  timed,
}: {
  rep: PracticeRep;
  view: PromptView;
  timed: boolean;
}) {
  const result = rep.rep.result;
  const overlap = overlapOf(rep);

  if (!result.correct) {
    return <span className="bad">{view.answer}</span>;
  }
  // A rep that measured overlap is a legato rep, and the share is what it was
  // judged on. Asked of the result rather than of the drill, like everything
  // else on this screen.
  if (overlap !== null) {
    return (
      <span className="ok">
        connected
        <span className="band automatic">{pct(overlap.inBandShare)} in band</span>
      </span>
    );
  }
  if (timed && result.timingErrorMs !== null) {
    const timing = result.timingErrorMs;
    return (
      <span className="ok">
        clean pass
        <span className="band automatic">
          {ms(timing.meanAbs)} off, sd {ms(timing.sd)}
        </span>
      </span>
    );
  }
  const band = latencyBand(result.latencyMs);
  return (
    <span className="ok">
      {result.latencyMs === null ? 'correct' : ms(result.latencyMs)}
      {band && <span className={`band ${band}`}>{latencyBandLabel(band)}</span>}
    </span>
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
  timed,
  last,
  idleHint,
}: {
  item: DrillItem | null;
  view: PromptView | null;
  timed: boolean;
  last: PracticeRep | null;
  idleHint: React.ReactNode;
}) {
  const r = useGradeRunner();
  const graded = r.state === 'answered' && last !== null && last.item === item;
  const result = graded && last ? last.rep.result : null;

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
      {timed && result === null && <PulseBar />}
      <div className="prompt-state">
        {/* Presenting is an ear prompt still playing. The clock has not started
            yet: latency runs from the end of playback, never from the paint. */}
        {result === null && r.state === 'presenting' && (
          <span className="settling">listen</span>
        )}
        {result === null && r.state !== 'presenting' && (
          <span className="muted">{timed ? 'play with the click' : 'waiting'}</span>
        )}
        {result !== null && last !== null && (
          <ResultLine rep={last} view={view} timed={timed} />
        )}
      </div>
    </div>
  );
}

/**
 * What went wrong, said in whichever space the drill graded in: pitch classes
 * for the octave-equivalent drills, notes for the ear drill, and counts rather
 * than a list of eight identical taps for a timed run.
 */
function MissDetail({ rep, view }: { rep: PracticeRep; view: PromptView }) {
  const { result, spec } = rep.rep;
  const name = nameFor(spec.constraints.octaveEquivalent === true, view.sharps);
  const event = result.perEvent[0];
  const overlap = overlapOf(rep);

  if (overlap !== null) {
    return <LegatoDetail result={result} overlap={overlap} />;
  }

  if (isTimed(rep)) {
    return <TimingDetail result={result} />;
  }

  return (
    <ul className="errors">
      {event?.status === 'wrong-inversion' && (
        <li>
          right notes, wrong bass: <strong>{view.answer.split(' ')[0]}</strong> has to be
          underneath
        </li>
      )}
      {/* Keyed by position, not by pitch: the same note can be reported more
          than once in one rep, and a duplicate key silently drops a line. */}
      {result.noteErrors.wrong.map((w, i) => (
        <li key={`w${i}`}>
          played <strong>{name(w.played)}</strong> where{' '}
          <strong>{name(w.expected)}</strong> was expected
        </li>
      ))}
      {result.noteErrors.missing.map((p, i) => (
        <li key={`m${i}`}>
          missing <strong>{name(p)}</strong>
        </li>
      ))}
      {result.noteErrors.extra.map((p, i) => (
        <li key={`e${i}`}>
          extra <strong>{name(p)}</strong>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why a run did not pass. The distinction it exists to draw is the one
 * session-generator.md section 2 draws when it rates a near miss `hard` rather
 * than `again`: notes in the wrong place is a different failure from notes in
 * the wrong order, and only one of them means the user cannot play the pattern.
 */
function TimingDetail({ result }: { result: GradeResult }) {
  const timing = result.timingErrorMs;
  const notes = countErrors(result);

  // Nothing landed on the grid at all: the run did not happen, and listing every
  // beat as a missing note says that eight times over instead of once.
  if (timing === null) {
    return (
      <ul className="errors">
        <li>
          nothing landed on the beat. The count-in is four clicks, then play on every
          click after it.
        </li>
      </ul>
    );
  }

  const rushing = timing.mean < 0;

  return (
    <ul className="errors">
      {notes === 0 ? (
        <li>
          every note landed. <strong>{ms(timing.meanAbs)}</strong> off the beat on
          average, {rushing ? 'ahead of' : 'behind'} the click by{' '}
          <strong>{ms(Math.abs(timing.mean))}</strong>, spread{' '}
          <strong>{ms(timing.sd)}</strong>
        </li>
      ) : (
        <li>
          <strong>{notes}</strong> note{notes === 1 ? '' : 's'} missing, extra or wrong.
          Play the pattern before playing it in time.
        </li>
      )}
      <li className="muted">
        {result.perEvent.filter((e) => e.status === 'on-time').length} of{' '}
        {result.perEvent.filter((e) => e.index >= 0).length} beats inside the window
      </li>
    </ul>
  );
}

/**
 * Why a legato run did not pass, which is a different question from why a timed
 * one did not.
 *
 * The distinction that matters here is the same one `ratingForPass` draws: right
 * notes with the hand letting go early is a near miss and comes back as `hard`,
 * while wrong notes mean the pattern itself is not there. Saying which is which
 * is the difference between a drill that teaches release timing and a drill that
 * says "no" to someone who played every note.
 */
function LegatoDetail({
  result,
  overlap,
}: {
  result: GradeResult;
  overlap: OverlapSummary;
}) {
  const notes = countErrors(result);

  if (notes > 0) {
    return (
      <ul className="errors">
        <li>
          <strong>{notes}</strong> note{notes === 1 ? '' : 's'} missing, extra or wrong.
          Play the pattern before playing it joined up.
        </li>
      </ul>
    );
  }

  if (overlap.transitions === 0) {
    return (
      <ul className="errors">
        <li>nothing to measure. Four clicks count you in, then play on every click.</li>
      </ul>
    );
  }

  const worst = OVERLAP_CLASSES.filter((c) => c !== 'in-band').sort(
    (a, b) => overlap.counts[b] - overlap.counts[a]
  )[0]!;

  return (
    <ul className="errors">
      <li>
        every note landed. <strong>{pct(overlap.inBandShare)}</strong> of the joins were
        in the band, and the rest were mostly{' '}
        <strong>{OVERLAP_CLASS_LABELS[worst]}</strong>.
      </li>
      <li className="muted">
        {worst === 'detached' || worst === 'near-legato'
          ? 'Letting go too early. Hold each key until the next one is already down.'
          : 'Holding on too long. The old key has to come up just after the new one lands, not later.'}
      </li>
      <li className="muted">
        <OverlapBars counts={overlap.counts} />
      </li>
    </ul>
  );
}

/** The five bands of architecture.md section 5, as counts. */
function OverlapBars({ counts }: { counts: OverlapSummary['counts'] }) {
  const total = OVERLAP_CLASSES.reduce((n, c) => n + counts[c], 0);
  if (total === 0) return null;
  return (
    <span className="overlap-bars">
      {OVERLAP_CLASSES.map((c) => (
        <span key={c} className={`overlap ${c}`} title={OVERLAP_CLASS_LABELS[c]}>
          <span className="overlap-count">{counts[c]}</span>
          <span className="overlap-label">{OVERLAP_CLASS_LABELS[c]}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The legato band, and the distribution it is supposed to be set from.
 *
 * architecture.md section 9.1 puts this band first on the list of numbers that
 * will be wrong: it was calibrated off one captured log showing ~60ms overlaps,
 * which puts the user at the smeared edge of [10, 60] on day one. Its own
 * instruction for fixing it is precise - "set the band edges at his current
 * p25/p75 and walk them toward [10, 60] over sessions" - so the control sits
 * beside the p25 and p75 it is meant to be set from, and the button does exactly
 * what that sentence says.
 *
 * The one thing it will not do is move on its own. A threshold that recalibrates
 * itself to whatever the hand is doing is not a threshold.
 */
function LegatoBandPanel({ reps }: { reps: readonly PracticeRep[] }) {
  const s = useProgressStore();
  const [floor, ceil] = s.settings.legatoBandMs;

  // Every overlap of the session, re-read against the band in force now rather
  // than against the one each rep was graded under, because this panel is about
  // where the band should be and not about who passed.
  const sample = useMemo(() => {
    const byHand = reps.flatMap((r) => r.rep.result.noteOverlapMs ?? []);
    return byHand.length === 0
      ? null
      : summariseOverlap(byHand, withTolerances({ legatoBandMs: [floor, ceil] }));
  }, [reps, floor, ceil]);

  if (sample === null) return null;

  const setBand = (next: [number, number]) => {
    void store.writeSettings({
      legatoBandMs: [Math.round(next[0]), Math.round(next[1])],
    });
  };

  return (
    <div className="panel">
      <h2>
        Legato band
        <span className="h2-note">the number section 9.1 expects to be wrong</span>
      </h2>

      <div className="counters">
        <div>
          <span className="num">{pct(sample.inBandShare)}</span>
          <span className="lbl">in band</span>
        </div>
        <div>
          <span className="num">
            {sample.medianMs === null ? '-' : ms(sample.medianMs)}
          </span>
          <span className="lbl">median overlap</span>
        </div>
        <div>
          <span className="num">{sample.transitions}</span>
          <span className="lbl">joins measured</span>
        </div>
      </div>

      <div className="toolbar">
        <label>
          band
          <input
            type="number"
            step={5}
            value={floor}
            onChange={(e) => setBand([Number(e.target.value), ceil])}
          />
        </label>
        <label>
          to
          <input
            type="number"
            step={5}
            value={ceil}
            onChange={(e) => setBand([floor, Number(e.target.value)])}
          />
          ms
        </label>
        <button
          disabled={sample.p25Ms === null || sample.p75Ms === null}
          title="architecture.md section 9.1: set the band edges at his current p25/p75, then walk them toward [10, 60] over sessions."
          onClick={() => setBand([sample.p25Ms!, sample.p75Ms!])}
        >
          Use this session ({sample.p25Ms === null ? '-' : ms(sample.p25Ms)} to{' '}
          {sample.p75Ms === null ? '-' : ms(sample.p75Ms)})
        </button>
        <span className="grow" />
        <button disabled={floor === 10 && ceil === 60} onClick={() => setBand([10, 60])}>
          Back to [10, 60]
        </button>
      </div>

      <p className="note muted">
        Widening the band is how the tree&apos;s stage ladder is climbed: stage 1 is
        awareness at [0, 80], stage 3 is mastery at [10, 60]. Moving it changes how the
        next rep is graded and not how the last one was, so a session graded under two
        bands is two samples rather than one. The raw overlaps are kept either way, so an
        old session can be re-read against a new band.
      </p>
    </div>
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

  /**
   * Starting practice starts audio. Two of the four drills are unanswerable
   * without it, since an ear prompt has to be heard and a pulse drill has to be
   * counted in, and this click is the user gesture Chrome requires. It is
   * awaited so that the first prompt of the session is not the silent one.
   */
  const begin = useCallback(() => {
    void (async () => {
      if (session.status !== 'ready') await session.start();
      if (mode === 'scheduled') await practice.startScheduled();
      else await practice.start(deck);
    })();
  }, [mode, deck]);

  const item = p.current;
  const template = useMemo(() => (item ? templateForItem(item) : null), [item]);
  const view = useMemo(
    () => (template && item ? template.view(item.params) : null),
    [template, item]
  );
  // "tempoBpm present => timed grading" (architecture.md section 2). The screen
  // asks the drill rather than being told which drill it is.
  const timed = useMemo(
    () =>
      template && item
        ? template.buildExpected(item.params).tempoBpm !== undefined
        : false,
    [template, item]
  );

  const last = p.reps.length > 0 ? p.reps[p.reps.length - 1]! : null;
  const graded = r.state === 'answered' && last !== null && last.item === item;
  const missed = graded && last !== null && !last.rep.result.correct;
  // Before a session exists there is no queue to ask, so the size of the deck
  // about to be started comes from the selection instead.
  const pending = useMemo(() => itemsForNodes(deck).length, [deck]);

  /**
   * Sound the prompt. Melodic for an ear drill, because an interval played as a
   * chord is a different exercise, and together for everything else.
   */
  const hear = useCallback(() => {
    if (!view || audio.status !== 'ready') return;
    if (template?.promptMode === 'audio') session.playSequence(view.audition);
    else session.play(view.audition);
  }, [view, template, audio.status]);

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
        timed={timed}
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
          {!running
            ? 'Start'
            : r.state !== 'waiting'
              ? 'Next'
              : timed
                ? 'Stop the run'
                : 'I do not know'}
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
        {/* Only once the session has produced overlaps. It is a calibration
            surface, and there is nothing to calibrate against yet otherwise. */}
        <LegatoBandPanel reps={p.reps} />
        <WorkListPanel reps={p.reps} />
        <HistoryPanel reps={p.reps} />
      </div>

      <p className="note muted">
        Latency runs from the prompt being ready to the last note of the answer going
        down, both read from MIDI timestamps, so a slow frame cannot flatter or spoil a
        number. For an ear prompt &quot;ready&quot; is the end of playback, so listening
        time is never charged to you. Correctness only decides whether the latency counts:
        under 1.2s schedules the item further out than 4s does, even though both are
        right. The pulse drill has no latency at all and is judged on where the notes
        landed instead: every note matched, average error and spread under the tree&apos;s
        maxima. Everything here is saved, and <a href="#/progress">progress</a> is where
        it adds up.
      </p>
    </div>
  );
}
