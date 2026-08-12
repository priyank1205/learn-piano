/**
 * The clock offset between the MIDI timeline and the audio timeline.
 *
 * This is the single highest-risk piece of the app. Web MIDI event timestamps
 * are DOMHighResTimeStamps on the `performance.now()` origin. `AudioContext`
 * time is seconds from context creation. They are different origins, so
 * subtracting one from the other produces a constant error that is invisible
 * in every UI and poisons every timing score the grader ever produces.
 *
 * The bridge is `AudioContext.getOutputTimestamp()`, which returns a *pair* of
 * readings describing one physical instant:
 *
 *   contextTime      the sample frame currently leaving the output device,
 *                    in the same units as `currentTime`
 *   performanceTime  an estimate of when that frame left the device,
 *                    on the `performance.now()` clock
 *
 * So `offsetMs = performanceTime - contextTime * 1000` converts between them.
 *
 * Note carefully *which* instant that pair describes: the sound arriving at
 * the speaker, not the sound being rendered into the graph. The pair therefore
 * already carries the output latency, and that is the version we want. Grading
 * compares when the user played against when they *heard* the beat, and both
 * sides of that comparison happen at the speaker, not in the render graph. A
 * naive `performance.now() - currentTime * 1000` would omit output latency and
 * report every note as played early by a fixed 5 to 30ms.
 *
 * The offset is not used to schedule playback. Live echo is always scheduled
 * as soon as possible; see engine.ts. The offset exists so that a MIDI event
 * can be placed on the audio timeline for measurement and, in slice 3, for
 * grading against a Transport grid.
 */

import { yieldToEventLoop } from './yield.ts';

/** One correlated reading of both clocks. */
export interface ClockPair {
  /** Seconds, AudioContext origin. */
  contextTime: number;
  /** Milliseconds, performance.now() origin. Same origin as NormalizedEvent.ts. */
  performanceTime: number;
}

/**
 * The subset of AudioContext this module needs. Narrowed to an interface so the
 * maths can be tested without an audio device, which matters because a wrong
 * offset here is silent and permanent.
 */
export interface ClockSource {
  currentTime: number;
  sampleRate: number;
  baseLatency?: number;
  outputLatency?: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

export type OffsetSource = 'output-timestamp' | 'current-time-fallback';

export interface Calibration {
  /** performanceTime = contextTime * 1000 + offsetMs. */
  offsetMs: number;
  source: OffsetSource;
  /** Every accepted per-reading offset, so the spread is auditable in the UI. */
  samples: number[];
  /** max - min across samples. Large spread means a noisy estimate. */
  spreadMs: number;
  /** Reads it took to collect them. High relative to samples means a slow clock. */
  attempts: number;
  sampleRate: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
  /** performance.now() at calibration, so drift can be reported against elapsed time. */
  calibratedAtMs: number;
  warnings: string[];
}

export const DEFAULT_SAMPLE_COUNT = 9;
/**
 * Ceilings on the sampling loop, so a context that never advances cannot hang
 * startup. Both are generous: nine distinct quanta normally take well under
 * 100ms.
 */
export const DEFAULT_MAX_ATTEMPTS = 4000;
export const DEFAULT_BUDGET_MS = 400;

/** Above this spread the estimate is noisy enough to be worth showing in red. */
export const SPREAD_WARN_MS = 4;

export function offsetMsFromPair(pair: ClockPair): number {
  return pair.performanceTime - pair.contextTime * 1000;
}

/** Place a MIDI event timestamp on the audio timeline. */
export function midiTsToContextTime(ts: number, offsetMs: number): number {
  return (ts - offsetMs) / 1000;
}

/** Place an audio-timeline instant on the MIDI timeline. */
export function contextTimeToMidiTs(contextTime: number, offsetMs: number): number {
  return contextTime * 1000 + offsetMs;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A pair is usable only when both members are finite and positive. Before the
 * context has rendered its first quantum both are 0, and some drivers report a
 * contextTime with no performanceTime at all. Either case has to be rejected
 * rather than folded into the median, or one bad reading shifts every score.
 */
export function isUsablePair(pair: {
  contextTime?: number;
  performanceTime?: number;
}): pair is ClockPair {
  const { contextTime, performanceTime } = pair;
  return (
    typeof contextTime === 'number' &&
    typeof performanceTime === 'number' &&
    Number.isFinite(contextTime) &&
    Number.isFinite(performanceTime) &&
    contextTime > 0 &&
    performanceTime > 0
  );
}

/**
 * One clock pair. Returns null when the context cannot yet produce a usable
 * one, so the caller can retry rather than record a wrong number.
 */
export function readPair(source: ClockSource): ClockPair | null {
  if (typeof source.getOutputTimestamp !== 'function') return null;
  const pair = source.getOutputTimestamp();
  return isUsablePair(pair) ? pair : null;
}

export function readOffsetMs(source: ClockSource): number | null {
  const pair = readPair(source);
  return pair === null ? null : offsetMsFromPair(pair);
}

/**
 * Fallback for a context with no usable getOutputTimestamp. `currentTime` is
 * the frame being *rendered*, which is `outputLatency` ahead of the frame
 * leaving the speaker, so subtracting the latency reconstructs the same instant
 * getOutputTimestamp would have reported. Where outputLatency is unavailable
 * this degrades to a small constant error, which is exactly why the source is
 * recorded on the Calibration and surfaced in the UI.
 */
export function fallbackOffsetMs(source: ClockSource, nowMs: number): number {
  const outputLatency = source.outputLatency ?? source.baseLatency ?? 0;
  return nowMs - (source.currentTime - outputLatency) * 1000;
}

export interface CalibrateOptions {
  sampleCount?: number;
  maxAttempts?: number;
  budgetMs?: number;
  now?: () => number;
  yieldFn?: () => Promise<void>;
}

/**
 * Sample the offset several times and take the median. A single reading is
 * quantised to the render quantum and can sit a few milliseconds off; the
 * median of a handful is robust to that without pretending to a precision the
 * platform does not offer.
 *
 * Readings must come from *distinct* render quanta or they are the same
 * measurement counted more than once, which would collapse the spread to zero
 * and make a noisy estimate look precise. The loop therefore rejects a pair
 * whose contextTime has not moved, rather than waiting a fixed number of
 * milliseconds between reads: a fixed wait would have to use a timer, and
 * timers are throttled to one per second in a background tab.
 */
export async function calibrate(
  source: ClockSource,
  options: CalibrateOptions = {}
): Promise<Calibration> {
  const {
    sampleCount = DEFAULT_SAMPLE_COUNT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    budgetMs = DEFAULT_BUDGET_MS,
    now = () => performance.now(),
    yieldFn = yieldToEventLoop,
  } = options;

  const samples: number[] = [];
  const warnings: string[] = [];
  const startedAt = now();
  let lastContextTime: number | null = null;
  let attempts = 0;

  while (samples.length < sampleCount && attempts < maxAttempts) {
    attempts += 1;
    const pair = readPair(source);
    if (pair !== null && pair.contextTime !== lastContextTime) {
      lastContextTime = pair.contextTime;
      samples.push(offsetMsFromPair(pair));
      if (samples.length >= sampleCount) break;
    }
    if (now() - startedAt >= budgetMs) break;
    await yieldFn();
  }

  const baseLatencyMs = (source.baseLatency ?? 0) * 1000;
  const outputLatencyMs = (source.outputLatency ?? 0) * 1000;

  if (samples.length === 0) {
    warnings.push(
      'getOutputTimestamp returned no usable reading. Falling back to currentTime, ' +
        'which is less accurate. Timing scores carry a small constant error.'
    );
    return {
      offsetMs: fallbackOffsetMs(source, now()),
      source: 'current-time-fallback',
      samples: [],
      spreadMs: 0,
      attempts,
      sampleRate: source.sampleRate,
      baseLatencyMs,
      outputLatencyMs,
      calibratedAtMs: now(),
      warnings,
    };
  }

  if (samples.length < sampleCount) {
    warnings.push(
      `Only ${samples.length} of ${sampleCount} distinct clock readings were ` +
        'available within the time budget. The context was probably still starting up.'
    );
  }

  const spreadMs = Math.max(...samples) - Math.min(...samples);
  if (spreadMs > SPREAD_WARN_MS) {
    warnings.push(
      `Clock readings spread over ${spreadMs.toFixed(2)}ms. The median is used, ` +
        'but expect timing noise of roughly that size.'
    );
  }

  return {
    offsetMs: median(samples),
    source: 'output-timestamp',
    samples,
    spreadMs,
    attempts,
    sampleRate: source.sampleRate,
    baseLatencyMs,
    outputLatencyMs,
    calibratedAtMs: now(),
    warnings,
  };
}

/**
 * Re-read the offset and report how far it has moved since calibration. The
 * two clocks are driven by different hardware and drift slowly relative to one
 * another; this exists so that drift is observed rather than assumed. It never
 * silently rewrites the calibration, because a moving offset would make two
 * reps of the same drill incomparable.
 */
export function driftMs(source: ClockSource, calibration: Calibration): number | null {
  const current = readOffsetMs(source);
  if (current === null) return null;
  return current - calibration.offsetMs;
}
