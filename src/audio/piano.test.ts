/**
 * Tests for the sample bank.
 *
 * Tone is judged by ear, not here. What these pin down is that the bank cannot
 * produce the failures that are hard to diagnose once notes are flying: clicks
 * from a buffer that starts or ends on a discontinuity, aliasing from partials
 * above Nyquist, NaN from a decay constant that went to zero, and a bank that
 * quietly stops covering the keyboard.
 */

import { describe, expect, it } from 'vitest';
import {
  BANK_HIGH_PITCH,
  BANK_LOW_PITCH,
  BANK_PITCHES,
  BANK_STEP,
  buildSampleBank,
  frequencyOf,
  partialsFor,
  renderPianoSample,
  sampleDurationSec,
} from './piano.ts';

const SR = 22050;
const noYield = () => Promise.resolve();

const peakOf = (buf: Float32Array) => {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
};

describe('bank coverage', () => {
  it('spans well past the 61 keys, because patterns may transpose two octaves', () => {
    // The CTK-2400 is MIDI 36..96. architecture.md section 3 allows +/-24.
    expect(BANK_LOW_PITCH).toBeLessThanOrEqual(36 - 12);
    expect(BANK_HIGH_PITCH).toBeGreaterThanOrEqual(96 + 12);
  });

  it('is spaced so the sampler never repitches a sample by more than 2 semitones', () => {
    expect(BANK_STEP).toBeLessThanOrEqual(4);
    for (let i = 1; i < BANK_PITCHES.length; i += 1) {
      expect(BANK_PITCHES[i]! - BANK_PITCHES[i - 1]!).toBe(BANK_STEP);
    }
  });

  it('covers every playable pitch within half a step of a real sample', () => {
    for (let pitch = 36; pitch <= 96; pitch += 1) {
      const nearest = Math.min(...BANK_PITCHES.map((p) => Math.abs(p - pitch)));
      expect(nearest).toBeLessThanOrEqual(BANK_STEP / 2);
    }
  });
});

describe('frequencyOf', () => {
  it('anchors on A440 and doubles per octave', () => {
    expect(frequencyOf(69)).toBeCloseTo(440, 9);
    expect(frequencyOf(57)).toBeCloseTo(220, 9);
    expect(frequencyOf(60)).toBeCloseTo(261.6255653, 6);
  });
});

describe('partialsFor', () => {
  it('keeps every partial below Nyquist, so nothing aliases', () => {
    for (const pitch of BANK_PITCHES) {
      for (const p of partialsFor(pitch, SR)) {
        expect(p.freq).toBeLessThan(SR / 2);
      }
    }
  });

  it('stretches the series above the pure harmonic one, as a stiff string does', () => {
    const f0 = frequencyOf(48);
    const partials = partialsFor(48, SR);
    expect(partials[0]!.freq).toBeGreaterThan(f0);
    // The stretch grows with partial number, which is what inharmonicity means.
    const stretch = partials.map((p, i) => p.freq / ((i + 1) * f0));
    expect(stretch[stretch.length - 1]!).toBeGreaterThan(stretch[0]!);
    // ...but it stays small enough to still read as one pitch.
    expect(stretch[0]!).toBeLessThan(1.01);
  });

  it('gives upper partials shorter decays than the fundamental', () => {
    const partials = partialsFor(48, SR);
    expect(partials.length).toBeGreaterThan(4);
    expect(partials[4]!.tauSlowSec).toBeLessThan(partials[0]!.tauSlowSec);
    expect(partials[0]!.tauFastSec).toBeLessThan(partials[0]!.tauSlowSec);
  });

  it('gives bass notes a longer partial series than treble notes', () => {
    expect(partialsFor(28, SR).length).toBeGreaterThan(partialsFor(96, SR).length);
  });

  it('produces only finite, positive-amplitude partials', () => {
    for (const pitch of BANK_PITCHES) {
      for (const p of partialsFor(pitch, SR)) {
        expect(Number.isFinite(p.freq)).toBe(true);
        expect(p.ampFast).toBeGreaterThan(0);
        expect(p.ampSlow).toBeGreaterThan(0);
        expect(p.tauSlowSec).toBeGreaterThan(0);
      }
    }
  });
});

describe('sampleDurationSec', () => {
  it('rings longer for lower notes', () => {
    expect(sampleDurationSec(36)).toBeGreaterThan(sampleDurationSec(72));
    expect(sampleDurationSec(72)).toBeGreaterThan(sampleDurationSec(BANK_HIGH_PITCH));
  });

  it('stays bounded so 22 buffers do not become a memory problem', () => {
    for (const pitch of BANK_PITCHES) {
      expect(sampleDurationSec(pitch)).toBeGreaterThanOrEqual(0.8);
      expect(sampleDurationSec(pitch)).toBeLessThanOrEqual(4.5);
    }
  });
});

describe('renderPianoSample', () => {
  it('starts and ends at silence, so no note can click', () => {
    for (const pitch of [24, 60, 96]) {
      const buf = renderPianoSample(pitch, SR);
      expect(Math.abs(buf[0]!)).toBe(0);
      expect(Math.abs(buf[buf.length - 1]!)).toBeLessThan(1e-6);
    }
  });

  it('contains no NaN or infinity', () => {
    for (const pitch of BANK_PITCHES) {
      const buf = renderPianoSample(pitch, SR);
      let bad = 0;
      for (const v of buf) if (!Number.isFinite(v)) bad += 1;
      expect(bad).toBe(0);
    }
  });

  it('never exceeds full scale, so the bank cannot clip on its own', () => {
    for (const pitch of BANK_PITCHES) {
      expect(peakOf(renderPianoSample(pitch, SR))).toBeLessThanOrEqual(1);
    }
  });

  it('actually makes sound', () => {
    const buf = renderPianoSample(60, SR);
    expect(peakOf(buf)).toBeGreaterThan(0.5);
  });

  it('tilts the treble down, or the top octave shrieks against the bass', () => {
    expect(peakOf(renderPianoSample(BANK_HIGH_PITCH, SR))).toBeLessThan(
      peakOf(renderPianoSample(48, SR))
    );
  });

  it('decays: the tail is quieter than the attack', () => {
    const buf = renderPianoSample(60, SR);
    const head = peakOf(buf.subarray(0, Math.round(0.2 * SR)));
    const tail = peakOf(buf.subarray(buf.length - Math.round(0.2 * SR)));
    expect(tail).toBeLessThan(head * 0.25);
  });

  it('is deterministic, so a change in tone is a change in this file', () => {
    const a = renderPianoSample(60, SR);
    const b = renderPianoSample(60, SR);
    expect(Array.from(a.subarray(0, 512))).toEqual(Array.from(b.subarray(0, 512)));
    expect(a.length).toBe(b.length);
  });

  it('has no step discontinuity at the very start of the attack', () => {
    const buf = renderPianoSample(60, SR);
    // The first millisecond must ramp, not jump.
    const firstMs = Math.round(SR / 1000);
    expect(peakOf(buf.subarray(0, firstMs))).toBeLessThan(peakOf(buf));
  });

  it('scales its length with the sample rate', () => {
    expect(renderPianoSample(60, 44100).length).toBe(
      Math.round(sampleDurationSec(60) * 44100)
    );
  });
});

describe('buildSampleBank', () => {
  it('renders every pitch in the bank and reports progress for each', async () => {
    const seen: number[] = [];
    const bank = await buildSampleBank(
      SR,
      (p) => {
        seen.push(p.pitch);
        expect(p.total).toBe(BANK_PITCHES.length);
      },
      noYield
    );
    expect(seen).toEqual([...BANK_PITCHES]);
    expect(bank.size).toBe(BANK_PITCHES.length);
    for (const pitch of BANK_PITCHES) {
      expect(bank.get(pitch)!.length).toBeGreaterThan(0);
    }
  });

  it('counts up to the total, so a progress bar can reach the end', async () => {
    const done: number[] = [];
    await buildSampleBank(SR, (p) => done.push(p.done), noYield);
    expect(done[0]).toBe(1);
    expect(done[done.length - 1]).toBe(BANK_PITCHES.length);
  });
});
