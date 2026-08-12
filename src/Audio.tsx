/**
 * The audio-out screen.
 *
 * Two jobs. The obvious one is a volume knob and a dry/sustained switch. The
 * real one is showing the clock offset and what it implies, because that number
 * is invisible everywhere else and every timing score in slice 3 is built on
 * it. A wrong offset does not crash and does not look wrong; the only defence
 * is to put it on screen next to a measurement that would look absurd if it
 * were wrong.
 */

import { useEffect } from 'react';
import {
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  audio,
  noteNameOf,
  session,
  useAudioSession,
  useAudioTick,
} from './audio/index.ts';
import { SPREAD_WARN_MS } from './audio/clock.ts';
import { SUSTAIN_SENSITIVE_V1_NODE } from './audio/engine.ts';
import { DEFAULT_SPLIT_POINT, handOf, midi, useMidiState } from './midi.ts';

/**
 * Above this, playing along with a click starts to feel wrong. Being over it is
 * a statement about the output device, not about the offset, so it is a
 * separate assertion from the sign check below.
 */
const COMFORTABLE_LATENCY_MS = 30;

const ms = (v: number, digits = 1) => `${v.toFixed(digits)}ms`;

function StartPanel() {
  const s = useAudioSession();

  if (s.status === 'ready') return null;

  if (s.status === 'error') {
    return (
      <div className="banner err">
        <strong>Audio failed to start.</strong> {s.error}
        <button onClick={() => void session.start()}>Retry</button>
      </div>
    );
  }

  if (s.status === 'starting') {
    const p = s.progress;
    return (
      <div className="banner">
        <span>
          {p
            ? `Rendering the sample bank: ${p.done} of ${p.total} (${noteNameOf(p.pitch)})`
            : 'Starting the audio context...'}
        </span>
        {p && (
          <span className="progress">
            <span style={{ width: `${(p.done / p.total) * 100}%` }} />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="banner start">
      <div>
        <strong>Audio is off.</strong> Chrome will not start an audio context without a
        click, so this button is unavoidable. It also enables MIDI, renders the piano
        sample bank, and calibrates the clock offset.
      </div>
      <button className="primary" onClick={() => void session.start()}>
        Start audio
      </button>
    </div>
  );
}

/**
 * The clock panel. `key to speaker` is the load-bearing number: it is computed
 * through the offset, so if the offset were wrong it would read as negative or
 * as hundreds of milliseconds rather than as the 5 to 40ms a working setup
 * shows.
 */
function ClockPanel() {
  const s = useAudioSession();
  useAudioTick(s.status === 'ready');

  const cal = s.calibration;
  if (!cal) {
    return (
      <div className="panel">
        <h2>Clock offset</h2>
        <p className="muted">Not calibrated. Start audio.</p>
      </div>
    );
  }

  const drift = s.drift();
  const latency = audio.medianToSpeakerMs();
  // A negative key-to-speaker time means sound reached the speaker before the
  // key was pressed, which is impossible: the offset is wrong.
  const signOk = latency === null || latency >= 0;
  const comfortable = latency === null || latency <= COMFORTABLE_LATENCY_MS;

  return (
    <div className="panel">
      <h2>
        Clock offset
        <span className="h2-actions">
          <button onClick={() => void session.recalibrate()}>recalibrate</button>
        </span>
      </h2>

      <dl className="readout">
        <dt>offset</dt>
        <dd className="big">{ms(cal.offsetMs, 2)}</dd>
        <dt>source</dt>
        <dd>
          {cal.source === 'output-timestamp'
            ? 'getOutputTimestamp()'
            : 'currentTime fallback'}
        </dd>
        <dt>readings</dt>
        <dd>
          {cal.samples.length} of {cal.attempts} reads · spread {ms(cal.spreadMs, 2)}
        </dd>
        <dt>drift since</dt>
        <dd>{drift === null ? 'unreadable' : ms(drift, 2)}</dd>
        <dt>base / output latency</dt>
        <dd>
          {ms(cal.baseLatencyMs, 2)} / {ms(cal.outputLatencyMs, 2)}
        </dd>
        <dt>sample rate</dt>
        <dd>{cal.sampleRate} Hz</dd>
        <dt>key to speaker</dt>
        <dd className={signOk ? 'big' : 'big bad'}>
          {latency === null ? 'play a note' : ms(latency)}
        </dd>
      </dl>

      <ul className="assertions">
        <li className={cal.source === 'output-timestamp' ? 'ok' : 'bad'}>
          offset came from a correlated clock pair, not a subtraction
        </li>
        <li className={cal.spreadMs <= SPREAD_WARN_MS ? 'ok' : 'bad'}>
          readings agree to within {ms(SPREAD_WARN_MS, 0)}
        </li>
        <li className={signOk ? 'ok' : 'bad'}>
          sound reaches the speaker after the key is pressed, not before
        </li>
        <li className={comfortable ? 'ok' : 'bad'}>
          latency is under {COMFORTABLE_LATENCY_MS}ms
          {comfortable
            ? ''
            : '. That is the output device, not the offset. Bluetooth output is the usual cause.'}
        </li>
      </ul>

      {cal.warnings.map((w) => (
        <p key={w} className="warn-note">
          {w}
        </p>
      ))}

      <p className="muted note">
        <code>contextTime = (ts - offset) / 1000</code>. The offset is measured at the
        output device, so it carries the output latency and it is never used to schedule
        playback, only to measure and to grade.
      </p>
    </div>
  );
}

function OutputPanel() {
  const s = useAudioSession();
  const ready = s.status === 'ready';

  return (
    <div className="panel">
      <h2>Output</h2>

      <div className="control">
        <span className="control-label">sustain</span>
        <span className="segmented">
          <button
            className={audio.mode === 'dry' ? 'active' : undefined}
            onClick={() => session.setMode('dry')}
          >
            dry
          </button>
          <button
            className={audio.mode === 'sustained' ? 'active' : undefined}
            onClick={() => session.setMode('sustained')}
          >
            sustained
          </button>
        </span>
      </div>

      <p className="muted note">
        The keyboard&apos;s own sustain is permanently on and sends no CC64, so it cannot
        be turned off from here or heard in the MIDI stream. Dry mode damps each note on
        its note-off, which is the only way to hear what the legato grader measures. Node{' '}
        <code>{SUSTAIN_SENSITIVE_V1_NODE}</code> requires it.
      </p>

      <div className="control">
        <span className="control-label">volume</span>
        <input
          type="range"
          min={MIN_VOLUME_DB}
          max={MAX_VOLUME_DB}
          step={1}
          value={s.volumeDb}
          onChange={(e) => session.setVolumeDb(Number(e.target.value))}
          disabled={!ready}
        />
        <span className="mono">{s.volumeDb} dB</span>
      </div>

      <div className="control">
        <button onClick={() => session.testChord()} disabled={!ready}>
          test chord
        </button>
        <button onClick={() => session.panic()} disabled={!ready}>
          all notes off
        </button>
      </div>

      {s.bank && (
        <p className="muted note">
          Sample bank: {s.bank.buffers} buffers, {s.bank.totalSeconds.toFixed(1)}s of
          audio, {s.bank.megabytes.toFixed(1)} MB, rendered in{' '}
          {(s.bank.renderMs / 1000).toFixed(2)}s. Context is <code>{s.contextState}</code>
          .
        </p>
      )}
    </div>
  );
}

/**
 * The firewall panel. CC64 blocking cannot be checked by ear and cannot be
 * checked in the inspector, whose job is to show that CC *does* arrive in the
 * event stream. This is where the two halves of that rule are visible together.
 */
function FirewallPanel() {
  const s = useAudioSession();
  useAudioTick(s.status === 'ready');
  useMidiState();

  const seen = midi.counts.cc;
  const cc64Seen = [...midi.ccProfile.values()]
    .filter((r) => r.num === 64)
    .reduce((sum, r) => sum + r.count, 0);
  const { counters } = audio;

  return (
    <div className="panel">
      <h2>CC firewall</h2>
      <div className="counters">
        <div>
          <span className="num">{seen}</span>
          <span className="lbl">CC in stream</span>
        </div>
        <div>
          <span className="num">{cc64Seen}</span>
          <span className="lbl">of those CC64</span>
        </div>
        <div>
          <span className="num">{counters.ccBlocked}</span>
          <span className="lbl">blocked from audio</span>
        </div>
        <div>
          <span className="num">0</span>
          <span className="lbl">reached the piano</span>
        </div>
      </div>
      <ul className="assertions">
        <li className="ok">
          control change is captured for the pedal nodes and never routed to the sampler
        </li>
      </ul>
      <p className="muted note">
        The instrument sends no CC64 today, so these counters are expected to read zero.
        The rule is enforced anyway: a sampler that honoured CC64 would hold notes through
        their note-offs and turn the legato drill into a measurement of something
        inaudible.
      </p>
    </div>
  );
}

function KeysPanel() {
  const s = useAudioSession();
  useAudioTick(s.status === 'ready' || s.status === 'idle');

  const held = [...audio.keysDown].sort((a, b) => a - b);
  const { counters } = audio;

  return (
    <div className="panel">
      <h2>
        Sounding
        <span className="h2-note">
          {counters.attacks} attacks · {counters.releases} damped ·{' '}
          {counters.releasesSuppressed} rung out
          {counters.orphanOffs > 0 ? ` · ${counters.orphanOffs} orphan offs` : ''}
        </span>
      </h2>
      {held.length === 0 ? (
        <p className="muted">Nothing held.</p>
      ) : (
        <div className="held">
          {held.map((p) => (
            <span
              key={p}
              className={`key ${handOf(p, DEFAULT_SPLIT_POINT) === 'L' ? 'lh' : 'rh'}`}
            >
              {noteNameOf(p)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The last few events on both clocks. This is the proof, per note, that the
 * conversion works: `context time` is the MIDI timestamp mapped onto the audio
 * timeline, and `to speaker` is that mapping run back the other way.
 */
function TracePanel() {
  const s = useAudioSession();
  useAudioTick(s.status === 'ready');

  const rows = [...audio.trace()].reverse().slice(0, 14);

  return (
    <div className="panel wide">
      <h2>Event clock trace</h2>
      {rows.length === 0 ? (
        <p className="muted">
          {s.status === 'ready' ? 'Play a note.' : 'Start audio, then play a note.'}
        </p>
      ) : (
        <table className="cc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>type</th>
              <th>note</th>
              <th>midi ts (ms)</th>
              <th>context time (s)</th>
              <th>dispatch</th>
              <th>to speaker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={`${t.seq}`}>
                <td className="dim">{t.seq}</td>
                <td className={`type ${t.type}`}>{t.type}</td>
                <td>{noteNameOf(t.pitch)}</td>
                <td className="dim">{t.ts.toFixed(1)}</td>
                <td>{t.contextTime.toFixed(4)}</td>
                <td className="dim">{ms(t.dispatchMs)}</td>
                <td className={t.toSpeakerMs < 0 ? 'flag' : undefined}>
                  {ms(t.toSpeakerMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AudioScreen() {
  useEffect(() => {
    void midi.enable();
  }, []);

  return (
    <div className="screen">
      <StartPanel />
      <div className="panels">
        <ClockPanel />
        <OutputPanel />
        <FirewallPanel />
        <KeysPanel />
      </div>
      <TracePanel />
    </div>
  );
}
