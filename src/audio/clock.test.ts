/**
 * Tests for the MIDI-to-audio clock offset.
 *
 * A wrong offset here does not crash, does not look wrong on screen, and shifts
 * every timing score in the app by a constant. These tests exist so the sign
 * and the origin of the conversion are pinned before any grader depends on it.
 */

import { describe, expect, it } from 'vitest';
import {
  SPREAD_WARN_MS,
  calibrate,
  contextTimeToMidiTs,
  driftMs,
  fallbackOffsetMs,
  isUsablePair,
  median,
  midiTsToContextTime,
  offsetMsFromPair,
  readOffsetMs,
} from './clock.ts';
import type { ClockSource } from './clock.ts';

const noYield = () => Promise.resolve();

/** One render quantum at 44.1kHz, which is how often the output clock moves. */
const QUANTUM_SEC = 128 / 44100;

/**
 * A fake context whose two clocks are related by a known offset, so a test can
 * assert the recovered offset equals the planted one. Its output clock advances
 * one quantum per read, like a running context; pass `quantumSec: 0` to
 * simulate one that is stalled.
 */
function fakeSource(opts: {
  offsetMs: number;
  startContextTime?: number;
  quantumSec?: number;
  jitterMs?: number[];
  outputLatency?: number;
  baseLatency?: number;
  getOutputTimestamp?: ClockSource['getOutputTimestamp'];
}): ClockSource {
  const quantum = opts.quantumSec ?? QUANTUM_SEC;
  const jitter = opts.jitterMs ?? [];
  const outputLatency = opts.outputLatency ?? 0.012;
  let contextTime = opts.startContextTime ?? 12.5;
  let call = 0;
  return {
    get currentTime() {
      return contextTime + outputLatency;
    },
    sampleRate: 48000,
    baseLatency: opts.baseLatency ?? 0.005,
    outputLatency,
    getOutputTimestamp:
      opts.getOutputTimestamp ??
      (() => {
        const wobble = jitter.length ? (jitter[call % jitter.length] ?? 0) : 0;
        call += 1;
        const reading = {
          contextTime,
          performanceTime: contextTime * 1000 + opts.offsetMs + wobble,
        };
        contextTime += quantum;
        return reading;
      }),
  };
}

describe('offset maths', () => {
  it('recovers the offset from a correlated pair', () => {
    // The audio context started 4321.5ms after the performance timeline origin.
    expect(
      offsetMsFromPair({ contextTime: 10, performanceTime: 10 * 1000 + 4321.5 })
    ).toBeCloseTo(4321.5, 9);
  });

  it('converts a MIDI timestamp onto the audio timeline', () => {
    const offsetMs = 4321.5;
    // An event at performance time 14321.5ms is 10s into the audio context.
    expect(midiTsToContextTime(14321.5, offsetMs)).toBeCloseTo(10, 9);
  });

  it('round-trips both directions', () => {
    const offsetMs = -812.25; // A context created before the page timeline is legal.
    const ts = 98765.4321;
    expect(contextTimeToMidiTs(midiTsToContextTime(ts, offsetMs), offsetMs)).toBeCloseTo(
      ts,
      9
    );
  });

  it('does not confuse the two origins by subtracting them directly', () => {
    // The bug this whole module exists to prevent: ts - currentTime*1000 is not
    // the offset, and the difference is exactly the offset itself.
    const source = fakeSource({
      offsetMs: 4321.5,
      startContextTime: 10,
      outputLatency: 0,
    });
    const naive = 14321.5 - source.currentTime * 1000;
    expect(naive).not.toBeCloseTo(midiTsToContextTime(14321.5, 4321.5), 3);
  });
});

describe('median', () => {
  it('takes the middle value for odd counts and the mean of the middle two for even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('is unmoved by a single wild reading', () => {
    expect(median([10, 10.2, 9.9, 10.1, 9000])).toBe(10.1);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('returns NaN for no samples rather than 0, which would look like a valid offset', () => {
    expect(median([])).toBeNaN();
  });
});

describe('isUsablePair', () => {
  it('accepts a fully populated pair', () => {
    expect(isUsablePair({ contextTime: 1, performanceTime: 2 })).toBe(true);
  });

  it('rejects the zeroes reported before the context has rendered anything', () => {
    expect(isUsablePair({ contextTime: 0, performanceTime: 0 })).toBe(false);
    expect(isUsablePair({ contextTime: 0, performanceTime: 5000 })).toBe(false);
  });

  it('rejects a pair missing performanceTime, which some drivers omit', () => {
    expect(isUsablePair({ contextTime: 4 })).toBe(false);
    expect(isUsablePair({})).toBe(false);
  });

  it('rejects non-finite readings', () => {
    expect(isUsablePair({ contextTime: NaN, performanceTime: 5 })).toBe(false);
    expect(isUsablePair({ contextTime: 5, performanceTime: Infinity })).toBe(false);
  });
});

describe('readOffsetMs', () => {
  it('reads the offset when the pair is usable', () => {
    expect(readOffsetMs(fakeSource({ offsetMs: 1234 }))).toBeCloseTo(1234, 6);
  });

  it('returns null rather than a number when the context has no timestamp support', () => {
    const source: ClockSource = { currentTime: 5, sampleRate: 48000 };
    expect(readOffsetMs(source)).toBeNull();
  });

  it('returns null while the context is still starting up', () => {
    const source = fakeSource({
      offsetMs: 0,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    });
    expect(readOffsetMs(source)).toBeNull();
  });
});

describe('calibrate', () => {
  it('recovers a planted offset exactly when readings are clean', async () => {
    const cal = await calibrate(fakeSource({ offsetMs: 4321.5 }), { yieldFn: noYield });
    expect(cal.source).toBe('output-timestamp');
    expect(cal.offsetMs).toBeCloseTo(4321.5, 6);
    expect(cal.spreadMs).toBeCloseTo(0, 9);
    expect(cal.warnings).toEqual([]);
  });

  it('medians away a single outlier reading', async () => {
    // One reading lands a full quantum late; the median must ignore it.
    const source = fakeSource({ offsetMs: 1000, jitterMs: [0, 0, 0, 0, 50, 0, 0, 0, 0] });
    const cal = await calibrate(source, { yieldFn: noYield, sampleCount: 9 });
    expect(cal.offsetMs).toBeCloseTo(1000, 6);
    expect(cal.samples).toHaveLength(9);
  });

  it('warns when the readings are spread wide, without refusing to produce an offset', async () => {
    const spread = SPREAD_WARN_MS + 6;
    const source = fakeSource({ offsetMs: 1000, jitterMs: [0, spread, spread / 2] });
    const cal = await calibrate(source, { yieldFn: noYield, sampleCount: 3 });
    expect(cal.spreadMs).toBeCloseTo(spread, 6);
    expect(cal.warnings.join(' ')).toMatch(/spread/i);
    expect(Number.isFinite(cal.offsetMs)).toBe(true);
  });

  it('rejects a re-read of the same render quantum, which is one measurement not two', async () => {
    // A stalled output clock: every read returns the same pair. Accepting them
    // would report nine readings with zero spread, which looks like precision
    // and is actually one number counted nine times.
    const stalled = fakeSource({ offsetMs: 1000, quantumSec: 0 });
    const cal = await calibrate(stalled, {
      yieldFn: noYield,
      sampleCount: 9,
      maxAttempts: 50,
    });
    expect(cal.samples).toHaveLength(1);
    expect(cal.offsetMs).toBeCloseTo(1000, 6);
    expect(cal.attempts).toBe(50);
    expect(cal.warnings.join(' ')).toMatch(/1 of 9/);
  });

  it('stops at the attempt ceiling rather than spinning forever', async () => {
    const stalled = fakeSource({ offsetMs: 0, quantumSec: 0 });
    const cal = await calibrate(stalled, {
      yieldFn: noYield,
      sampleCount: 9,
      maxAttempts: 7,
    });
    expect(cal.attempts).toBe(7);
  });

  it('stops at the time budget rather than spinning forever', async () => {
    let clock = 0;
    const stalled = fakeSource({ offsetMs: 0, quantumSec: 0 });
    const cal = await calibrate(stalled, {
      yieldFn: noYield,
      sampleCount: 9,
      budgetMs: 100,
      now: () => (clock += 30),
    });
    expect(cal.attempts).toBeLessThan(9);
    expect(cal.source).toBe('output-timestamp');
  });

  it('skips unusable readings and warns, but still uses the good ones', async () => {
    let call = 0;
    const source = fakeSource({
      offsetMs: 0,
      getOutputTimestamp: () => {
        call += 1;
        // The first two readings arrive before the context is rendering.
        if (call <= 2) return { contextTime: 0, performanceTime: 0 };
        return { contextTime: call, performanceTime: call * 1000 + 777 };
      },
    });
    const cal = await calibrate(source, {
      yieldFn: noYield,
      sampleCount: 5,
      maxAttempts: 5,
    });
    expect(cal.offsetMs).toBeCloseTo(777, 6);
    expect(cal.samples).toHaveLength(3);
    expect(cal.warnings.join(' ')).toMatch(/3 of 5/);
  });

  it('falls back to currentTime when no reading is ever usable, and says so', async () => {
    const source: ClockSource = {
      currentTime: 10,
      sampleRate: 48000,
      baseLatency: 0.005,
      outputLatency: 0.012,
    };
    const cal = await calibrate(source, { yieldFn: noYield, now: () => 14321.5 });
    expect(cal.source).toBe('current-time-fallback');
    expect(cal.samples).toEqual([]);
    expect(cal.warnings.join(' ')).toMatch(/getOutputTimestamp/);
    // 14321.5 - (10 - 0.012) * 1000
    expect(cal.offsetMs).toBeCloseTo(4333.5, 6);
  });

  it('reports the platform latencies in milliseconds', async () => {
    const cal = await calibrate(
      fakeSource({ offsetMs: 0, baseLatency: 0.0053, outputLatency: 0.0117 }),
      { yieldFn: noYield }
    );
    expect(cal.baseLatencyMs).toBeCloseTo(5.3, 6);
    expect(cal.outputLatencyMs).toBeCloseTo(11.7, 6);
    expect(cal.sampleRate).toBe(48000);
  });

  it('yields between attempts, so startup does not block the main thread', async () => {
    let yields = 0;
    const cal = await calibrate(fakeSource({ offsetMs: 0 }), {
      sampleCount: 4,
      yieldFn: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(cal.samples).toHaveLength(4);
    // One yield between each pair of readings, and none after the last.
    expect(yields).toBe(3);
  });
});

describe('fallbackOffsetMs', () => {
  it('subtracts the output latency so it lands on the same instant as getOutputTimestamp', () => {
    const source: ClockSource = {
      currentTime: 10,
      sampleRate: 48000,
      outputLatency: 0.02,
    };
    expect(fallbackOffsetMs(source, 14321.5)).toBeCloseTo(14321.5 - 9980, 6);
  });

  it('uses baseLatency when outputLatency is unavailable', () => {
    const source: ClockSource = {
      currentTime: 10,
      sampleRate: 48000,
      baseLatency: 0.005,
    };
    expect(fallbackOffsetMs(source, 10000)).toBeCloseTo(10000 - 9995, 6);
  });
});

describe('driftMs', () => {
  it('reports movement of the offset since calibration', async () => {
    let planted = 1000;
    let contextTime = 12.5;
    const source: ClockSource = {
      get currentTime() {
        return contextTime;
      },
      sampleRate: 48000,
      getOutputTimestamp: () => {
        const reading = {
          contextTime,
          performanceTime: contextTime * 1000 + planted,
        };
        contextTime += QUANTUM_SEC;
        return reading;
      },
    };
    const cal = await calibrate(source, { yieldFn: noYield });
    expect(driftMs(source, cal)).toBeCloseTo(0, 6);
    planted = 1003.5;
    expect(driftMs(source, cal)).toBeCloseTo(3.5, 6);
  });

  it('returns null rather than a fake zero when the clock cannot be read', async () => {
    const good = fakeSource({ offsetMs: 500 });
    const cal = await calibrate(good, { yieldFn: noYield });
    const dead: ClockSource = { currentTime: 1, sampleRate: 48000 };
    expect(driftMs(dead, cal)).toBeNull();
  });
});
