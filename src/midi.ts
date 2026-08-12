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
   * raw bytes off it and branch on the status byte ourselves.
   */
  private onRawMessage(e: unknown, portId: string) {
    const evt = e as {
      message?: { data?: Uint8Array | number[]; rawData?: Uint8Array };
      data?: Uint8Array | number[];
      rawData?: Uint8Array;
      timestamp?: number;
    };
    const bytes = evt.message?.data ?? evt.data ?? evt.message?.rawData ?? evt.rawData;
    if (!bytes || bytes.length < 1) return;

    const raw = Array.from(bytes);
    const statusByte = raw[0] ?? 0;
    // System realtime (0xF8 clock, 0xFE active sensing) arrive constantly on some
    // devices and would drown the log. Nothing downstream uses them.
    if (statusByte >= 0xf0) return;

    const kind = statusByte & 0xf0;
    const channel = (statusByte & 0x0f) + 1;
    const d1 = raw[1] ?? 0;
    const d2 = raw[2] ?? 0;

    let ts = typeof evt.timestamp === 'number' ? evt.timestamp : 0;
    let tsSynthetic = false;
    if (!ts) {
      ts = performance.now();
      tsSynthetic = true;
    }

    const base = { ts, channel, statusByte, raw, portId, seq: this.seq++ };

    if (kind === 0x90 && d2 > 0) {
      this.velocitiesSeen.add(d2);
      this.counts.on += 1;
      this.emit({
        ...base,
        type: 'on',
        pitch: d1,
        velocity: d2,
        ...(tsSynthetic && { tsSynthetic }),
      });
      return;
    }

    // True note-off. This is the path the Casio actually uses.
    if (kind === 0x80) {
      this.counts.offStatus128 += 1;
      this.emit({
        ...base,
        type: 'off',
        pitch: d1,
        velocity: 0,
        releaseVelocity: d2,
        offSource: 'status-128',
        ...(tsSynthetic && { tsSynthetic }),
      });
      return;
    }

    // Defensive fallback: note-on with velocity 0 means note-off on some devices.
    // Not expected from this instrument; tagged so the inspector proves it.
    if (kind === 0x90 && d2 === 0) {
      this.counts.offVelocity0 += 1;
      this.emit({
        ...base,
        type: 'off',
        pitch: d1,
        velocity: 0,
        offSource: 'velocity-0',
        ...(tsSynthetic && { tsSynthetic }),
      });
      return;
    }

    if (kind === 0xb0) {
      this.counts.cc += 1;
      this.emit({
        ...base,
        type: 'cc',
        pitch: -1,
        velocity: 0,
        cc: { num: d1, val: d2 },
        ...(tsSynthetic && { tsSynthetic }),
      });
      return;
    }
    // Everything else (pitch bend, aftertouch, program change) is deliberately dropped.
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
    this.counts.on = 0;
    this.counts.offStatus128 = 0;
    this.counts.offVelocity0 = 0;
    this.counts.cc = 0;
    this.bumpState();
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
