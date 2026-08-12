/**
 * AudioOut: the routing layer between the normalized MIDI stream and the
 * sampled piano.
 *
 * Deliberately free of Tone.js and Web Audio. Everything that decides *whether*
 * a message reaches the speakers lives here behind a small `PianoVoice`
 * interface, so the rules can be tested without an audio device. The Tone
 * wiring is in index.ts.
 *
 * Two rules this file exists to enforce:
 *
 *  1. Control change never reaches the audio path. See `shouldReachAudio`.
 *  2. In dry mode, a note-off stops the note. The instrument's own sustain is
 *     permanently on and inaudible to MIDI, so the app piano is the only place
 *     the user can hear what the legato grader is measuring
 *     (architecture.md section 6, node pr-legato-5finger).
 */

import type { NormalizedEvent } from '../midi.ts';
import { contextTimeToMidiTs, midiTsToContextTime } from './clock.ts';

/**
 * dry: note-off damps the note, so separation and overlap are audible.
 * sustained: note-off is ignored and samples ring out to their natural decay.
 */
export type SustainMode = 'dry' | 'sustained';

/** How fast a damped note dies in dry mode. Real dampers take roughly this long. */
export const DRY_RELEASE_SEC = 0.09;

/** The one V1 node that requires dry playback. Referenced so the link is greppable. */
export const SUSTAIN_SENSITIVE_V1_NODE = 'pr-legato-5finger';

/** Minimal contract the sampled piano has to satisfy. */
export interface PianoVoice {
  attack(pitch: number): void;
  release(pitch: number): void;
  releaseAll(): void;
  setReleaseSeconds(seconds: number): void;
}

/**
 * The audio firewall.
 *
 * Only note events move air. Control change is captured in the event stream by
 * midi.ts and is available to the pedal nodes the day a pedal exists, but it is
 * never handed to the sampler.
 *
 * CC64 is the case that matters. The instrument's sustain is a panel setting
 * local to its own sound engine and transmits nothing, so today this blocks a
 * message that never arrives. It is written anyway because every sampler's
 * default behaviour on CC64 is to hold notes through their note-offs, and that
 * would silently destroy the one thing the app piano exists to provide: an
 * audible account of note separation. A pedal plugged in years from now must
 * not be able to turn the legato drill into a lie.
 */
export function shouldReachAudio(event: NormalizedEvent): boolean {
  return event.type === 'on' || event.type === 'off';
}

export interface AudioCounters {
  attacks: number;
  releases: number;
  /** Note-offs suppressed because sustained mode was on. */
  releasesSuppressed: number;
  ccBlocked: number;
  /** Subset of ccBlocked with controller 64. The number the pedal work will care about. */
  cc64Blocked: number;
  /** A note-off with no matching note-on. Usually means an event was missed. */
  orphanOffs: number;
}

/**
 * One note event, with its position on both clocks. This is the live proof that
 * the offset is right: `toSpeakerMs` is derived through the offset, so a wrong
 * offset shows up here as an absurd number rather than as a silent constant
 * error in slice 3.
 */
export interface NoteTrace {
  seq: number;
  type: 'on' | 'off';
  pitch: number;
  /** MIDI event timestamp, performance.now() origin. */
  ts: number;
  /** The same instant on the audio clock. */
  contextTime: number;
  /** Driver to app: how long the event took to reach this code. */
  dispatchMs: number;
  /** Key press to sound leaving the speaker. The number the user actually feels. */
  toSpeakerMs: number;
}

const TRACE_CAPACITY = 40;

export interface AudioOutOptions {
  /** performance.now(), same origin as NormalizedEvent.ts. */
  nowMs: () => number;
  /** AudioContext.currentTime. */
  contextTime: () => number;
  /** Calibrated offset, or null when audio has not been started yet. */
  offsetMs: () => number | null;
}

/**
 * Routes note events to a voice and records what it did.
 *
 * Playback is always scheduled as soon as possible. The clock offset is *not*
 * used to place playback in time: a MIDI event is already in the past by the
 * time this code runs, so the earliest honest moment to make a sound is now.
 * The offset is used only to measure and, in slice 3, to grade.
 */
export class AudioOut {
  mode: SustainMode = 'dry';

  readonly counters: AudioCounters = {
    attacks: 0,
    releases: 0,
    releasesSuppressed: 0,
    ccBlocked: 0,
    cc64Blocked: 0,
    orphanOffs: 0,
  };

  readonly keysDown = new Set<number>();

  private traceLog: NoteTrace[] = [];
  private voice: PianoVoice | null = null;
  private opts: AudioOutOptions;

  constructor(opts: AudioOutOptions) {
    this.opts = opts;
  }

  attachVoice(voice: PianoVoice): void {
    this.voice = voice;
    voice.setReleaseSeconds(DRY_RELEASE_SEC);
  }

  detachVoice(): void {
    this.voice?.releaseAll();
    this.voice = null;
    this.keysDown.clear();
  }

  hasVoice(): boolean {
    return this.voice !== null;
  }

  setMode(mode: SustainMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Leaving sustained mode has to damp whatever is still ringing from notes
    // whose note-off was suppressed, or the change is inaudible until silence.
    if (mode === 'dry') {
      const held = [...this.keysDown];
      this.voice?.releaseAll();
      for (const pitch of held) this.voice?.attack(pitch);
    }
  }

  /**
   * The single entry point from the MIDI stream. Order matters: the firewall
   * runs before anything else touches the voice.
   */
  handleEvent(event: NormalizedEvent): void {
    if (!shouldReachAudio(event)) {
      this.counters.ccBlocked += 1;
      if (event.cc?.num === 64) this.counters.cc64Blocked += 1;
      return;
    }

    const nowMs = this.opts.nowMs();
    const contextNow = this.opts.contextTime();

    if (event.type === 'on') {
      this.keysDown.add(event.pitch);
      this.voice?.attack(event.pitch);
      this.counters.attacks += 1;
    } else {
      if (!this.keysDown.delete(event.pitch)) this.counters.orphanOffs += 1;
      if (this.mode === 'dry') {
        this.voice?.release(event.pitch);
        this.counters.releases += 1;
      } else {
        this.counters.releasesSuppressed += 1;
      }
    }

    this.pushTrace(event, nowMs, contextNow);
  }

  private pushTrace(event: NormalizedEvent, nowMs: number, contextNow: number): void {
    const offsetMs = this.opts.offsetMs();
    if (offsetMs === null) return;

    this.traceLog.push({
      seq: event.seq,
      type: event.type === 'on' ? 'on' : 'off',
      pitch: event.pitch,
      ts: event.ts,
      contextTime: midiTsToContextTime(event.ts, offsetMs),
      dispatchMs: nowMs - event.ts,
      // Mapping the scheduling instant back onto the MIDI clock lands on the
      // moment that audio reaches the speaker, because the offset was measured
      // at the output device.
      toSpeakerMs: contextTimeToMidiTs(contextNow, offsetMs) - event.ts,
    });

    if (this.traceLog.length > TRACE_CAPACITY) {
      this.traceLog.splice(0, this.traceLog.length - TRACE_CAPACITY);
    }
  }

  trace(): readonly NoteTrace[] {
    return this.traceLog;
  }

  /** Median key-to-speaker latency over the trace, or null with nothing to measure. */
  medianToSpeakerMs(): number | null {
    const values = this.traceLog
      .filter((t) => t.type === 'on')
      .map((t) => t.toSpeakerMs)
      .sort((a, b) => a - b);
    if (values.length === 0) return null;
    const mid = values.length >> 1;
    return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  }

  panic(): void {
    this.voice?.releaseAll();
    this.keysDown.clear();
  }

  resetCounters(): void {
    this.counters.attacks = 0;
    this.counters.releases = 0;
    this.counters.releasesSuppressed = 0;
    this.counters.ccBlocked = 0;
    this.counters.cc64Blocked = 0;
    this.counters.orphanOffs = 0;
    this.traceLog = [];
  }
}
