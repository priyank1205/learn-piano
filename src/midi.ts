/**
 * MIDI ingest layer.
 *
 * Hardware facts this code is written against (CLAUDE.md, confirmed from a real
 * event log on the Casio CTK-2400):
 *
 *  - Every note-on arrives at velocity 100. Velocity is captured here and NEVER
 *    graded. Nothing downstream may read it as expression.
 *  - Note-offs are true status-128 (0x80) messages with release velocity 64.
 *    We parse 0x80 explicitly. Note-on-with-velocity-0 is kept as a defensive
 *    fallback only, and is tagged so the inspector can show which path fired.
 *  - Everything arrives on channel 1. Hands are indistinguishable at the
 *    protocol level, so they are split by pitch at a configurable split point
 *    (default MIDI 60 / C4). Channel is captured so the assumption stays visible.
 *  - Sustain is on at the instrument, local to its sound engine, and transmits
 *    no CC64. We still parse CC so pedal nodes work the day a pedal appears.
 *
 * We subscribe to the raw `midimessage` event and decode the status byte
 * ourselves rather than using webmidi.js's noteon/noteoff abstraction, because
 * that abstraction folds velocity-0 note-ons into note-offs and would hide
 * exactly the distinction the inspector exists to prove.
 */

import { WebMidi } from 'webmidi';
import type { Input } from 'webmidi';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** Default hand split point: MIDI 60 = C4. Configurable in settings. */
export const DEFAULT_SPLIT_POINT = 60;

export type MidiEventType = 'on' | 'off' | 'cc';
export type Hand = 'L' | 'R';

/**
 * The normalized event, per architecture.md section 1. This is the only shape
 * anything downstream (audio, graders, store) is allowed to see.
 */
export interface NormalizedEvent {
  type: MidiEventType;
  /** MIDI note number 0..127. Set to -1 for 'cc' events, where it has no meaning. */
  pitch: number;
  /** DOMHighResTimeStamp, same origin as performance.now(). */
  ts: DOMHighResTimeStamp;
  cc?: { num: number; val: number };

  /** Captured, never graded. Always 100 on this instrument. */
  velocity: number;
  /** Release velocity for true 0x80 note-offs (64 on this instrument). */
  releaseVelocity?: number;
  /** 1-based. Always 1 on this instrument. */
  channel: number;

  /** Which code path produced an 'off'. The whole point of the inspector. */
  offSource?: 'status-128' | 'velocity-0';
  statusByte: number;
  raw: readonly number[];
  /** Monotonic counter, so React keys stay stable and ordering is never ambiguous. */
  seq: number;
  /** Port id the message arrived on. */
  portId: string;
  /**
   * True when the driver handed us no usable timestamp and we substituted
   * performance.now(). If this is ever true, timing scores are suspect.
   */
  tsSynthetic?: boolean;
}

export interface PortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
  connection: string;
}

export type IngestStatus = 'idle' | 'enabling' | 'ready' | 'error';

/** Ring buffer size for the live inspector log. */
const LOG_CAPACITY = 2000;

export function handOf(pitch: number, splitPoint: number): Hand {
  return pitch < splitPoint ? 'L' : 'R';
}

/** Running summary of one controller, per channel. */
export interface CcProfileEntry {
  num: number;
  channel: number;
  count: number;
  min: number;
  max: number;
  last: number;
  /** Distinct values seen, capped so a sweeping controller cannot grow unbounded. */
  values: number[];
  firstTs: number;
  lastTs: number;
}

/**
 * Standard MIDI controller names, for the CC breakdown panel. Only the ones a
 * consumer keyboard plausibly emits; anything else is shown as its bare number.
 */
export const CC_NAMES: Record<number, string> = {
  0: 'Bank Select MSB',
  1: 'Modulation',
  5: 'Portamento Time',
  6: 'Data Entry MSB',
  7: 'Channel Volume',
  10: 'Pan',
  11: 'Expression',
  32: 'Bank Select LSB',
  38: 'Data Entry LSB',
  64: 'Sustain Pedal',
  65: 'Portamento',
  66: 'Sostenuto',
  67: 'Soft Pedal',
  71: 'Resonance',
  74: 'Brightness',
  84: 'Portamento Control',
  91: 'Reverb Send',
  93: 'Chorus Send',
  98: 'NRPN LSB',
  99: 'NRPN MSB',
  100: 'RPN LSB',
  101: 'RPN MSB',
  120: 'All Sound Off',
  121: 'Reset All Controllers',
  122: 'Local Control',
  123: 'All Notes Off',
  124: 'Omni Off',
  125: 'Omni On',
  126: 'Mono Mode',
  127: 'Poly Mode',
};

export const ccLabel = (num: number) => CC_NAMES[num] ?? `CC${num}`;

/**
 * Pure status-byte decoder. Kept separate from the ingest class so it can be
 * unit tested without a MIDI device or a browser, since every timing number the
 * app ever produces depends on this being right.
 *
 * Returns null for messages the app deliberately ignores.
 */
export function decodeMessage(
  raw: number[],
  timestamp: number | undefined,
  ctx: { portId: string; seq: number; now: () => number }
): NormalizedEvent | null {
  if (raw.length < 1) return null;

  const statusByte = raw[0] ?? 0;
  // A data byte in status position means running status, which Web MIDI never
  // delivers (it always hands over complete messages). Treat it as corrupt.
  if (statusByte < 0x80) return null;
  // System realtime (0xF8 clock, 0xFE active sensing) and sysex arrive constantly
  // on some devices and would drown the log. Nothing downstream uses them.
  if (statusByte >= 0xf0) return null;

  const kind = statusByte & 0xf0;
  const channel = (statusByte & 0x0f) + 1;
  const d1 = raw[1] ?? 0;
  const d2 = raw[2] ?? 0;

  // A timestamp of 0 is what a driver reports when it has no clock of its own.
  // Substituting performance.now() keeps the stream usable but makes every
  // timing score suspect, so the substitution is flagged rather than hidden.
  const hasTs = typeof timestamp === 'number' && timestamp > 0;
  const ts = hasTs ? timestamp : ctx.now();
  const synthetic = hasTs ? {} : { tsSynthetic: true as const };

  const base = { ts, channel, statusByte, raw, portId: ctx.portId, seq: ctx.seq };

  if (kind === 0x90 && d2 > 0) {
    return { ...base, type: 'on', pitch: d1, velocity: d2, ...synthetic };
  }

  // True note-off. This is the path the Casio actually uses.
  if (kind === 0x80) {
    return {
      ...base,
      type: 'off',
      pitch: d1,
      velocity: 0,
      releaseVelocity: d2,
      offSource: 'status-128',
      ...synthetic,
    };
  }

  // Defensive fallback: note-on with velocity 0 means note-off on some devices.
  // Not expected from this instrument; tagged so the inspector proves it.
  if (kind === 0x90 && d2 === 0) {
    return {
      ...base,
      type: 'off',
      pitch: d1,
      velocity: 0,
      offSource: 'velocity-0',
      ...synthetic,
    };
  }

  if (kind === 0xb0) {
    return {
      ...base,
      type: 'cc',
      pitch: -1,
      velocity: 0,
      cc: { num: d1, val: d2 },
      ...synthetic,
    };
  }

  // Pitch bend, aftertouch and program change are deliberately dropped.
  return null;
}

class MidiIngest {
  status: IngestStatus = 'idle';
  error: string | null = null;
  inputs: PortInfo[] = [];

  private events: NormalizedEvent[] = [];
  private seq = 0;
  private eventSubs = new Set<(e: NormalizedEvent) => void>();
  private stateSubs = new Set<() => void>();
  private boundInputs = new Set<string>();
  private stateSnapshot = 0;

  /** Distinct velocities observed. Should only ever contain 100. */
  readonly velocitiesSeen = new Set<number>();
  /** Counts by note-off provenance, shown in the inspector. */
  readonly counts = { on: 0, offStatus128: 0, offVelocity0: 0, cc: 0 };
  /** Per-controller summary, keyed `${channel}:${num}`. */
  readonly ccProfile = new Map<string, CcProfileEntry>();

  subscribe(fn: (e: NormalizedEvent) => void): () => void {
    this.eventSubs.add(fn);
    return () => this.eventSubs.delete(fn);
  }

  subscribeState = (fn: () => void): (() => void) => {
    this.stateSubs.add(fn);
    return () => {
      this.stateSubs.delete(fn);
    };
  };

  /** Version counter so useSyncExternalStore can cheaply detect state changes. */
  getStateSnapshot = (): number => this.stateSnapshot;

  private bumpState() {
    this.stateSnapshot += 1;
    for (const fn of this.stateSubs) fn();
  }

  async enable(): Promise<void> {
    if (this.status === 'enabling' || this.status === 'ready') return;
    this.status = 'enabling';
    this.error = null;
    this.bumpState();

    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      this.status = 'error';
      this.error =
        'Web MIDI is not available in this browser. This app is Chromium only, by design.';
      this.bumpState();
      return;
    }

    try {
      await WebMidi.enable({ sysex: false });
      this.status = 'ready';
      this.refreshInputs();

      WebMidi.addListener('connected', () => this.refreshInputs());
      WebMidi.addListener('disconnected', () => this.refreshInputs());
      this.bumpState();
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.bumpState();
    }
  }

  private refreshInputs() {
    this.inputs = WebMidi.inputs.map((i) => ({
      id: i.id,
      name: i.name,
      manufacturer: i.manufacturer || 'unknown',
      state: i.state,
      connection: i.connection,
    }));
    for (const input of WebMidi.inputs) this.bindInput(input);
    this.bumpState();
  }

  private bindInput(input: Input) {
    if (this.boundInputs.has(input.id)) return;
    this.boundInputs.add(input.id);
    input.addListener('midimessage', (e) => this.onRawMessage(e, input.id));
  }

  /**
   * Decode one raw MIDI message. `e` is webmidi.js's MessageEvent; we read the
   * raw bytes off it and hand them to the pure decoder.
   */
  private onRawMessage(e: unknown, portId: string) {
    const evt = e as {
      message?: { data?: Uint8Array | number[]; rawData?: Uint8Array };
      data?: Uint8Array | number[];
      rawData?: Uint8Array;
      timestamp?: number;
    };
    const bytes = evt.message?.data ?? evt.data ?? evt.message?.rawData ?? evt.rawData;
    if (!bytes) return;

    const event = decodeMessage(Array.from(bytes), evt.timestamp, {
      portId,
      seq: this.seq,
      now: () => performance.now(),
    });
    if (!event) return;

    this.seq += 1;
    if (event.type === 'on') {
      this.velocitiesSeen.add(event.velocity);
      this.counts.on += 1;
    } else if (event.type === 'off') {
      if (event.offSource === 'velocity-0') this.counts.offVelocity0 += 1;
      else this.counts.offStatus128 += 1;
    } else if (event.type === 'cc' && event.cc) {
      this.counts.cc += 1;
      this.profileCc(event.cc.num, event.cc.val, event.channel, event.ts);
    }
    this.emit(event);
  }

  /**
   * Running per-controller summary. Aggregated here rather than derived from the
   * log, so a power-on burst is still visible after the ring buffer has rolled.
   */
  private profileCc(num: number, val: number, channel: number, ts: number) {
    const key = `${channel}:${num}`;
    const existing = this.ccProfile.get(key);
    if (existing) {
      existing.count += 1;
      existing.min = Math.min(existing.min, val);
      existing.max = Math.max(existing.max, val);
      existing.last = val;
      existing.lastTs = ts;
      if (!existing.values.includes(val) && existing.values.length < 12) {
        existing.values.push(val);
      }
      return;
    }
    this.ccProfile.set(key, {
      num,
      channel,
      count: 1,
      min: val,
      max: val,
      last: val,
      values: [val],
      firstTs: ts,
      lastTs: ts,
    });
  }

  private emit(event: NormalizedEvent) {
    this.events.push(event);
    if (this.events.length > LOG_CAPACITY) {
      this.events.splice(0, this.events.length - LOG_CAPACITY);
    }
    for (const fn of this.eventSubs) fn(event);
  }

  recent(): readonly NormalizedEvent[] {
    return this.events;
  }

  clear() {
    this.events = [];
    this.velocitiesSeen.clear();
    this.ccProfile.clear();
    this.counts.on = 0;
    this.counts.offStatus128 = 0;
    this.counts.offVelocity0 = 0;
    this.counts.cc = 0;
    this.bumpState();
  }

  /** Plain-text CC summary, so a finding can be pasted somewhere useful. */
  ccReport(): string {
    const rows = [...this.ccProfile.values()].sort(
      (a, b) => a.channel - b.channel || a.num - b.num
    );
    if (rows.length === 0) return 'No control change messages received.';
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const t0 = Math.min(...rows.map((r) => r.firstTs));
    const lines = rows.map(
      (r) =>
        `CC${String(r.num).padStart(3)} ch${r.channel}  n=${String(r.count).padStart(4)}  ` +
        `values=[${r.values.join(', ')}]  last=${r.last}  ` +
        `window=${(r.firstTs - t0).toFixed(0)}..${(r.lastTs - t0).toFixed(0)}ms  ` +
        `${ccLabel(r.num)}`
    );
    return [`${total} CC messages across ${rows.length} controllers:`, ...lines].join(
      '\n'
    );
  }
}

/** One ingest for the whole app. Drills and the inspector share this stream. */
export const midi = new MidiIngest();

/** Enable status, device list, counters. Re-renders only when those change. */
export function useMidiState() {
  useSyncExternalStore(midi.subscribeState, midi.getStateSnapshot, midi.getStateSnapshot);
  return midi;
}

/**
 * Live event log, batched to one render per animation frame so a fast trill
 * cannot flood React with re-renders.
 */
export function useMidiLog(paused: boolean) {
  const [log, setLog] = useState<NormalizedEvent[]>([]);
  const pending = useRef<NormalizedEvent[]>([]);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      frame.current = null;
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLog((prev) => {
        const next = prev.concat(batch);
        return next.length > LOG_CAPACITY ? next.slice(next.length - LOG_CAPACITY) : next;
      });
    };

    const unsub = midi.subscribe((e) => {
      if (paused) return;
      pending.current.push(e);
      frame.current ??= requestAnimationFrame(flush);
    });

    return () => {
      unsub();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [paused]);

  const clear = useCallback(() => {
    pending.current = [];
    setLog([]);
    midi.clear();
  }, []);

  return { log, clear };
}

/** Currently sounding notes, derived from the live stream. */
export function useHeldNotes() {
  const [held, setHeld] = useState<number[]>([]);

  useEffect(() => {
    const down = new Set<number>();
    return midi.subscribe((e) => {
      if (e.type === 'on') down.add(e.pitch);
      else if (e.type === 'off') down.delete(e.pitch);
      else return;
      setHeld([...down].sort((a, b) => a - b));
    });
  }, []);

  return held;
}
