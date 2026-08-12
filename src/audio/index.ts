/**
 * Audio session lifecycle: the Web Audio and Tone.js wiring that engine.ts and
 * clock.ts are deliberately kept free of.
 *
 * Responsibilities, in the order they happen:
 *
 *  1. Create the AudioContext with latencyHint 'interactive' (CLAUDE.md) from a
 *     user gesture, because Chrome will not start one otherwise.
 *  2. Set Tone's lookAhead to 0. Tone's default is 100ms of scheduling
 *     headroom, which is correct for sequenced material and catastrophic for
 *     echoing a keyboard: it would put a tenth of a second between the key and
 *     the sound.
 *  3. Render the sample bank and hand it to a Tone.Sampler.
 *  4. Calibrate the MIDI-to-audio clock offset, once, and keep it.
 *  5. Subscribe the routing engine to the MIDI stream.
 */

import * as Tone from 'tone';
import { Midi } from 'tonal';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { midi } from '../midi.ts';
import { AudioOut } from './engine.ts';
import type { PianoVoice, SustainMode } from './engine.ts';
import { buildSampleBank } from './piano.ts';
import type { BankProgress } from './piano.ts';
import { calibrate, driftMs } from './clock.ts';
import type { Calibration, ClockSource } from './clock.ts';

export type AudioStatus = 'idle' | 'starting' | 'ready' | 'error';

/** Quiet enough that a ten-note chord has headroom before the limiter works. */
export const DEFAULT_VOLUME_DB = -6;
export const MIN_VOLUME_DB = -40;
export const MAX_VOLUME_DB = 6;

/** Sharps rather than flats: unambiguous to parse, and only ever shown in debug UI. */
const NOTE_NAMES: readonly string[] = Array.from(
  { length: 128 },
  (_, pitch) => Midi.midiToNoteName(pitch, { sharps: true }) || `midi${pitch}`
);

export const noteNameOf = (pitch: number): string => NOTE_NAMES[pitch] ?? `midi${pitch}`;

/**
 * Module-level so the AudioOut singleton can read the clock without the
 * session and the engine holding references to each other.
 */
let context: Tone.Context | null = null;
let calibration: Calibration | null = null;

export const audio = new AudioOut({
  nowMs: () => performance.now(),
  contextTime: () => context?.currentTime ?? 0,
  offsetMs: () => calibration?.offsetMs ?? null,
});

/**
 * The live context as the narrow shape clock.ts wants. An AudioContext already
 * satisfies ClockSource structurally; naming the conversion here keeps the
 * clock module free of any Tone or Web Audio types.
 */
const clockSource = (): ClockSource | null => context?.rawContext ?? null;

class SamplerVoice implements PianoVoice {
  private readonly sampler: Tone.Sampler;

  constructor(sampler: Tone.Sampler) {
    this.sampler = sampler;
  }

  attack(pitch: number): void {
    // No time argument: with lookAhead at 0 this schedules at currentTime,
    // which is the earliest the graph can render. A MIDI event is already in
    // the past by the time it gets here, so "now" is the only honest answer.
    this.sampler.triggerAttack(noteNameOf(pitch));
  }

  release(pitch: number): void {
    this.sampler.triggerRelease(noteNameOf(pitch));
  }

  releaseAll(): void {
    this.sampler.releaseAll();
  }

  setReleaseSeconds(seconds: number): void {
    this.sampler.release = seconds;
  }
}

export interface BankStats {
  buffers: number;
  /** Wall-clock time spent rendering the bank, so a slow machine is visible. */
  renderMs: number;
  totalSeconds: number;
  megabytes: number;
}

class AudioSession {
  status: AudioStatus = 'idle';
  error: string | null = null;
  progress: BankProgress | null = null;
  bank: BankStats | null = null;
  volumeDb = DEFAULT_VOLUME_DB;

  private sampler: Tone.Sampler | null = null;
  private volumeNode: Tone.Volume | null = null;
  private unsubscribeMidi: (() => void) | null = null;
  private subs = new Set<() => void>();
  private snapshot = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  getSnapshot = (): number => this.snapshot;

  /** Called from the animation frame the UI already runs, so live numbers move. */
  bump(): void {
    this.snapshot += 1;
    for (const fn of this.subs) fn();
  }

  get calibration(): Calibration | null {
    return calibration;
  }

  get contextState(): string {
    return context?.rawContext.state ?? 'none';
  }

  get sampleRate(): number | null {
    return context?.sampleRate ?? null;
  }

  /** Must be called from a user gesture. Chrome will not start a context otherwise. */
  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') return;
    this.status = 'starting';
    this.error = null;
    this.bump();

    try {
      // The keyboard is the input; starting audio without it is pointless, and
      // asking for both behind one button keeps the start flow to one click.
      void midi.enable();

      const raw = new AudioContext({ latencyHint: 'interactive' });
      const ctx = new Tone.Context(raw);
      // See the header note: Tone's 100ms default would be audible as lag.
      ctx.lookAhead = 0;
      Tone.setContext(ctx);
      context = ctx;
      await ctx.resume();

      const startedAt = performance.now();
      const buffers = await buildSampleBank(raw.sampleRate, (p) => {
        this.progress = p;
        this.bump();
      });
      const renderMs = performance.now() - startedAt;

      const urls: Record<string, AudioBuffer> = {};
      let totalFrames = 0;
      for (const [pitch, data] of buffers) {
        const buffer = raw.createBuffer(1, data.length, raw.sampleRate);
        buffer.copyToChannel(data, 0);
        urls[noteNameOf(pitch)] = buffer;
        totalFrames += data.length;
      }

      this.bank = {
        buffers: buffers.size,
        renderMs,
        totalSeconds: totalFrames / raw.sampleRate,
        megabytes: (totalFrames * 4) / (1024 * 1024),
      };

      // The limiter is a safety net, not an effect. In sustained mode note-offs
      // are ignored, so a dense passage can stack many ringing voices.
      const limiter = new Tone.Limiter(-2).toDestination();
      this.volumeNode = new Tone.Volume(this.volumeDb).connect(limiter);
      this.sampler = new Tone.Sampler({
        urls,
        attack: 0,
        curve: 'exponential',
      }).connect(this.volumeNode);

      calibration = await calibrate(raw);

      audio.attachVoice(new SamplerVoice(this.sampler));
      this.unsubscribeMidi ??= midi.subscribe((event) => audio.handleEvent(event));

      this.progress = null;
      this.status = 'ready';
      this.bump();
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.bump();
    }
  }

  setVolumeDb(db: number): void {
    this.volumeDb = db;
    if (this.volumeNode) this.volumeNode.volume.value = db;
    this.bump();
  }

  setMode(mode: SustainMode): void {
    audio.setMode(mode);
    this.bump();
  }

  /** Re-read the clock offset without changing the stored one. */
  drift(): number | null {
    const raw = clockSource();
    if (!raw || !calibration) return null;
    return driftMs(raw, calibration);
  }

  /**
   * Recalibrate on demand. Offered because a device change (headphones in,
   * output switched) changes the output latency and therefore the offset, and
   * because seeing the number move is the only way to build trust in it.
   */
  async recalibrate(): Promise<void> {
    const raw = clockSource();
    if (!raw) return;
    calibration = await calibrate(raw);
    this.bump();
  }

  /** A C major arpeggio, for checking the speakers without touching the keyboard. */
  testChord(): void {
    if (!this.sampler) return;
    void context?.resume();
    const notes = [60, 64, 67, 72].map(noteNameOf);
    this.sampler.triggerAttackRelease(notes, 1.6);
  }

  panic(): void {
    audio.panic();
    this.bump();
  }
}

export const session = new AudioSession();

/** Status, bank stats, calibration. Re-renders only when those change. */
export function useAudioSession(): AudioSession {
  useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return session;
}

/**
 * A slow repaint for the live readouts (drift, latency trace, keys down).
 * Driven by requestAnimationFrame rather than setInterval: nothing here is
 * musical, but the app has exactly one timing discipline and it is easier to
 * keep than to remember the exception.
 */
export function useAudioTick(active: boolean, periodMs = 200): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < periodMs) return;
      last = now;
      setTick((t) => t + 1);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active, periodMs]);

  return tick;
}
