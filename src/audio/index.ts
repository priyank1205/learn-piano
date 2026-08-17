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
 *
 * Slice 6 added two ways for the app to make a sound on purpose rather than in
 * response to a key: a melodic sequence for ear prompts, and the metronome the
 * pulse drill is played against. Neither ever re-enters the MIDI stream, so
 * nothing the app plays can influence a grade.
 */

import * as Tone from 'tone';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { midi } from '../midi.ts';
import { noteNameOf } from '../theory.ts';
import { AudioOut } from './engine.ts';
import type { PianoVoice, SustainMode } from './engine.ts';
import { buildSampleBank } from './piano.ts';
import type { BankProgress } from './piano.ts';
import { calibrate, driftMs } from './clock.ts';
import type { Calibration, ClockSource } from './clock.ts';
import { contextTimeToMidiTs } from './clock.ts';
import { planPulse } from './transport.ts';
import type { PulsePlan } from './transport.ts';

export type AudioStatus = 'idle' | 'starting' | 'ready' | 'error';

/** Quiet enough that a ten-note chord has headroom before the limiter works. */
export const DEFAULT_VOLUME_DB = -6;
export const MIN_VOLUME_DB = -40;
export const MAX_VOLUME_DB = 6;

/**
 * The sampler keys its buffers by note name, and theory.ts owns note naming.
 * Re-exported because this module is what the audio screens already import.
 * Sharps, deliberately: the sample bank's keys have to be one stable spelling.
 */
export { noteNameOf };

/** The beat grid, re-exported so a screen can read a run without reaching past this module. */
export { beatIndexAt, beatSecondsOf, planPulse } from './transport.ts';
export type { PulseOptions, PulsePlan } from './transport.ts';

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

/**
 * How long before the first click a run is scheduled. Long enough that every
 * click is booked well ahead of the audio thread, short enough that pressing
 * space does not feel like nothing happened.
 */
export const PULSE_LEAD_SEC = 0.12;

/** Downbeat and offbeat click pitches, in Hz. High and short: a tick, not a note. */
const CLICK_HZ = { down: 1600, beat: 1100 };
const CLICK_SEC = 0.03;

/** Ear prompts: how long each note of a melodic interval sounds. */
export const EAR_NOTE_SEC = 0.55;

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

  /** The run the pulse drill is currently playing against, if any. */
  pulse: PulsePlan | null = null;

  private sampler: Tone.Sampler | null = null;
  private volumeNode: Tone.Volume | null = null;
  private click: Tone.Synth | null = null;
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

      // The metronome. A sine blip rather than a sampled woodblock: it has to be
      // heard through a chord without being part of it, and a short high tick is
      // the least musical thing available.
      this.click = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
        volume: -10,
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

  /**
   * Sound a set of pitches. Used by the speaker check and by the grader bench's
   * "hear it" button, which plays the chord the prompt is asking for.
   *
   * Not part of the grading path: a drill may play a prompt, but nothing the
   * app sounds is ever fed back into the event stream, so this cannot influence
   * a grade.
   */
  play(pitches: readonly number[], seconds = 1.6): void {
    if (!this.sampler) return;
    void context?.resume();
    this.sampler.triggerAttackRelease(
      pitches.map((p) => noteNameOf(p)),
      seconds
    );
  }

  /**
   * Sound pitches one after another, and say when the last one stops.
   *
   * This is how an ear prompt is delivered, so the return value matters as much
   * as the sound: architecture.md section 5 defines `promptReadyAt` for an ear
   * drill as the **end of audio playback**, and latency is measured from there
   * so that listening time is never charged to the user. The end is computed on
   * the audio clock and converted once through the calibrated offset, because
   * the answer it will be subtracted from is a MIDI timestamp.
   *
   * Returns null when there is no audio to play through, which the caller has to
   * handle: an ear prompt nobody can hear is not a rep.
   */
  playSequence(
    pitches: readonly number[],
    noteSec = EAR_NOTE_SEC
  ): { endsAtSec: number; endsAtMs: number } | null {
    if (!this.sampler || pitches.length === 0) return null;
    const offsetMs = calibration?.offsetMs;
    if (offsetMs === undefined) return null;
    void context?.resume();

    const startSec = (context?.currentTime ?? 0) + PULSE_LEAD_SEC;
    pitches.forEach((pitch, i) => {
      this.sampler?.triggerAttackRelease(
        noteNameOf(pitch),
        noteSec,
        startSec + i * noteSec
      );
    });

    const endsAtSec = startSec + pitches.length * noteSec;
    return { endsAtSec, endsAtMs: contextTimeToMidiTs(endsAtSec, offsetMs) };
  }

  /**
   * Start the metronome for one timed rep, and return the grid it plays.
   *
   * The Transport owns musical time here: the tempo, the position, and the beat
   * length every click is derived from (CLAUDE.md: Tone's Transport for the
   * clock, never `setInterval`). What it deliberately does not own is the
   * *dispatch* of each click. `lookAhead` is 0 for the whole app so that echoing
   * a key press is not delayed by a tenth of a second, and with no look-ahead
   * Tone's clock hands a scheduled callback a time that has already passed, up
   * to one update interval (50ms) late. That is inaudible for a UI callback and
   * ruinous for a metronome the user is being graded against. So every click of
   * the run is booked up front at its absolute time on the audio clock, which is
   * sample accurate, and the plan those times come from is the same object the
   * grader is handed as its grid.
   *
   * Returns null when audio has not been started, since there is no clock offset
   * to place the grid on and therefore nothing honest to grade against.
   */
  startPulse(opts: {
    bpm: number;
    countInBeats: number;
    beats: number;
  }): PulsePlan | null {
    if (!this.click || !context) return null;
    const offsetMs = calibration?.offsetMs;
    if (offsetMs === undefined) return null;
    void context.resume();

    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.position = 0;
    transport.bpm.value = opts.bpm;

    const plan = planPulse({
      startSec: context.currentTime + PULSE_LEAD_SEC,
      bpm: opts.bpm,
      countInBeats: opts.countInBeats,
      beats: opts.beats,
      offsetMs,
    });

    transport.start(plan.startSec);
    plan.clickTimesSec.forEach((time, i) => {
      const down = i === plan.gridStartIndex || (i - plan.gridStartIndex) % 4 === 0;
      this.click?.triggerAttackRelease(
        down ? CLICK_HZ.down : CLICK_HZ.beat,
        CLICK_SEC,
        time
      );
    });

    this.pulse = plan;
    this.bump();
    return plan;
  }

  /**
   * Stop the metronome. Safe to call when nothing is running.
   *
   * Clicks are booked ahead of time (see `startPulse`), so stopping the
   * Transport does not silence the ones already scheduled. Cancelling the click
   * envelope from now onward is what actually ends the run, and it is the price
   * of scheduling ahead rather than dispatching late.
   */
  stopPulse(): void {
    if (!context) return;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    this.click?.envelope.cancel(context.currentTime);
    if (this.pulse !== null) {
      this.pulse = null;
      this.bump();
    }
  }

  /** A C major arpeggio, for checking the speakers without touching the keyboard. */
  testChord(): void {
    this.play([60, 64, 67, 72]);
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
 *
 * Returns the frame timestamp of the last repaint, which shares an origin with
 * `performance.now()` and with every MIDI event timestamp. Callers that need to
 * show a countdown read it from here rather than calling the clock while
 * rendering, which React rejects as impure and which would make the same render
 * produce a different number each time. 0 means no frame has run yet.
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
      setTick(now);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active, periodMs]);

  return tick;
}
