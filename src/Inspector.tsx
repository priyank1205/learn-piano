/**
 * MIDI inspector. A permanent debug route, per CLAUDE.md: this is the ground
 * truth when a grader misbehaves. It shows the raw bytes next to the normalized
 * event so a disagreement between the two is always visible.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Midi } from 'tonal';
import {
  DEFAULT_SPLIT_POINT,
  handOf,
  midi,
  useHeldNotes,
  useMidiLog,
  useMidiState,
} from './midi.ts';
import type { NormalizedEvent } from './midi.ts';

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const noteName = (pitch: number) =>
  pitch < 0 ? '' : (Midi.midiToNoteName(pitch) ?? '?');

function StatusBanner() {
  const state = useMidiState();

  if (state.status === 'ready') {
    const count = state.inputs.length;
    return (
      <div className={count ? 'banner ok' : 'banner warn'}>
        {count > 0
          ? `Web MIDI enabled. ${count} input${count === 1 ? '' : 's'} connected.`
          : 'Web MIDI enabled, but no inputs are connected. Plug in the CTK-2400 over USB.'}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="banner err">
        <strong>MIDI unavailable.</strong> {state.error}
        <button onClick={() => void midi.enable()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="banner">
      {state.status === 'enabling' ? 'Requesting MIDI access...' : 'MIDI not started.'}
      <button onClick={() => void midi.enable()}>Enable MIDI</button>
    </div>
  );
}

function Devices() {
  const state = useMidiState();
  if (state.inputs.length === 0) return null;
  return (
    <div className="panel">
      <h2>Inputs</h2>
      <ul className="devices">
        {state.inputs.map((i) => (
          <li key={i.id}>
            <span className={`dot ${i.state === 'connected' ? 'on' : 'off'}`} />
            <strong>{i.name}</strong>
            <span className="muted">
              {i.manufacturer} · {i.state} · {i.connection}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Counters({ log }: { log: NormalizedEvent[] }) {
  const state = useMidiState();
  const { counts } = state;
  const velocities = [...state.velocitiesSeen].sort((a, b) => a - b);
  const channels = useMemo(
    () => [...new Set(log.map((e) => e.channel))].sort((a, b) => a - b),
    [log]
  );
  const syntheticTs = useMemo(() => log.some((e) => e.tsSynthetic), [log]);

  // These two assertions are the hardware facts from CLAUDE.md. If either ever
  // goes red, a downstream assumption is wrong and the graders need revisiting.
  const velocityOk =
    velocities.length === 0 || (velocities.length === 1 && velocities[0] === 100);
  const channelOk = channels.length <= 1 && (channels.length === 0 || channels[0] === 1);

  return (
    <div className="panel">
      <h2>Counters</h2>
      <div className="counters">
        <div>
          <span className="num">{counts.on}</span>
          <span className="lbl">note-on</span>
        </div>
        <div>
          <span className="num">{counts.offStatus128}</span>
          <span className="lbl">note-off (0x80)</span>
        </div>
        <div>
          <span className={counts.offVelocity0 > 0 ? 'num flag' : 'num'}>
            {counts.offVelocity0}
          </span>
          <span className="lbl">note-off (vel 0)</span>
        </div>
        <div>
          <span className="num">{counts.cc}</span>
          <span className="lbl">control change</span>
        </div>
      </div>
      <ul className="assertions">
        <li className={velocityOk ? 'ok' : 'bad'}>
          velocity is always 100:{' '}
          <code>{velocities.length ? velocities.join(', ') : 'no data yet'}</code>
        </li>
        <li className={channelOk ? 'ok' : 'bad'}>
          all notes on channel 1:{' '}
          <code>{channels.length ? channels.join(', ') : 'no data yet'}</code>
        </li>
        <li className={syntheticTs ? 'bad' : 'ok'}>
          driver supplies real timestamps:{' '}
          <code>{syntheticTs ? 'NO, substituting performance.now()' : 'yes'}</code>
        </li>
      </ul>
    </div>
  );
}

function HeldNotes({ splitPoint }: { splitPoint: number }) {
  const held = useHeldNotes();
  return (
    <div className="panel">
      <h2>Sounding now</h2>
      {held.length === 0 ? (
        <p className="muted">Nothing held.</p>
      ) : (
        <div className="held">
          {held.map((p) => (
            <span
              key={p}
              className={`key ${handOf(p, splitPoint) === 'L' ? 'lh' : 'rh'}`}
            >
              {noteName(p)}
              <small>{handOf(p, splitPoint)}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Inspector() {
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [splitPoint, setSplitPoint] = useState(DEFAULT_SPLIT_POINT);
  const { log, clear } = useMidiLog(paused);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void midi.enable();
  }, []);

  useEffect(() => {
    if (!autoscroll || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [log, autoscroll]);

  const t0 = log[0]?.ts ?? 0;
  const rows = log.slice(-400);

  return (
    <div className="inspector">
      <StatusBanner />
      <div className="panels">
        <Devices />
        <Counters log={log} />
        <HeldNotes splitPoint={splitPoint} />
      </div>

      <div className="toolbar">
        <button onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={clear}>Clear</button>
        <label>
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
          />
          autoscroll
        </label>
        <label className="split">
          split point
          <input
            type="number"
            min={21}
            max={108}
            value={splitPoint}
            onChange={(e) => setSplitPoint(Number(e.target.value))}
          />
          <span className="muted">{noteName(splitPoint)}</span>
        </label>
        <span className="muted grow">
          {log.length} event{log.length === 1 ? '' : 's'}
          {log.length > rows.length ? ` (showing last ${rows.length})` : ''}
        </span>
      </div>

      <div className="log" ref={bodyRef}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>t (ms)</th>
              <th>Δ</th>
              <th>type</th>
              <th>note</th>
              <th>pitch</th>
              <th>hand</th>
              <th>vel</th>
              <th>ch</th>
              <th>status</th>
              <th>bytes</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const prev = i > 0 ? rows[i - 1] : undefined;
              const delta = prev ? e.ts - prev.ts : 0;
              return (
                <tr key={e.seq} className={`row-${e.type}`}>
                  <td className="dim">{e.seq}</td>
                  <td>{(e.ts - t0).toFixed(1)}</td>
                  <td className="dim">{prev ? `+${delta.toFixed(1)}` : ''}</td>
                  <td className={`type ${e.type}`}>{e.type}</td>
                  <td>{e.type === 'cc' ? `CC${e.cc?.num}` : noteName(e.pitch)}</td>
                  <td className="dim">{e.type === 'cc' ? (e.cc?.val ?? '') : e.pitch}</td>
                  <td className="dim">
                    {e.type === 'cc' ? '' : handOf(e.pitch, splitPoint)}
                  </td>
                  <td className="dim">
                    {e.type === 'on' ? e.velocity : (e.releaseVelocity ?? '')}
                  </td>
                  <td className="dim">{e.channel}</td>
                  <td className="dim">0x{hex(e.statusByte)}</td>
                  <td className="dim bytes">{e.raw.map(hex).join(' ')}</td>
                  <td className={e.offSource === 'velocity-0' ? 'flag' : 'dim'}>
                    {e.offSource ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {log.length === 0 && (
          <p className="empty">
            Waiting for MIDI. Press a key on the CTK-2400 and events appear here.
          </p>
        )}
      </div>
    </div>
  );
}
