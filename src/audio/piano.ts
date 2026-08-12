/**
 * The sample bank for the app's piano.
 *
 * CLAUDE.md calls for a Web Audio sampled piano. This module renders that
 * sample set locally at first start rather than shipping or fetching recorded
 * audio: adding a sample library would be a new dependency, and fetching from a
 * CDN would put a network round trip and an offline failure mode between the
 * user and their daily practice. The synthesis below is a physically motivated
 * additive model (inharmonic partial series, per-partial double decay, hammer
 * noise), not a recording, and it is the one place in slice 2 that trades
 * fidelity for self-containment.
 *
 * The output shape is what matters architecturally: a multisampled bank of
 * AudioBuffers played back by Tone.Sampler. Swapping in recorded samples later
 * means replacing `buildSampleBank` and nothing else.
 *
 * Everything here is deterministic. The PRNG is seeded from the pitch, so the
 * bank is byte-identical between runs and a regression in the tone is a
 * regression in this file rather than in the weather.
 */

import { yieldToEventLoop } from './yield.ts';

/** Sampled every 4 semitones, so Tone.Sampler never repitches by more than 2. */
export const BANK_STEP = 4;
export const BANK_LOW_PITCH = 24;
/**
 * The CTK-2400 is 61 keys, but architecture.md section 3 allows a whole
 * expected pattern to transpose by up to two octaves, so the bank covers more
 * than the instrument does.
 */
export const BANK_HIGH_PITCH = 108;

export const BANK_PITCHES: readonly number[] = (() => {
  const out: number[] = [];
  for (let p = BANK_LOW_PITCH; p <= BANK_HIGH_PITCH; p += BANK_STEP) out.push(p);
  return out;
})();

/**
 * Partials above this are inaudible on laptop speakers and cost real render
 * time in the bass, where the partial count is otherwise unbounded.
 */
const MAX_PARTIAL_HZ = 14000;

/** Cheap deterministic PRNG (mulberry32). Seeded per pitch. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (lo: number, x: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function frequencyOf(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/**
 * Decay time constant of the fundamental. Bass strings ring for many seconds,
 * treble strings for well under one. The curve is fitted by ear, not measured.
 */
export function decayTauSec(pitch: number): number {
  return 7.5 * Math.pow(2, -(pitch - BANK_LOW_PITCH) / 26);
}

/**
 * How much sample to render. Capped at 4.5s: past that the tail is inaudible
 * under the limiter, and 22 buffers of unbounded length is real memory.
 */
export function sampleDurationSec(pitch: number): number {
  return clamp(0.8, decayTauSec(pitch) * 1.9 + 0.25, 4.5);
}

/**
 * Partial budget. Bass notes need a long series to sound like strings rather
 * than a sine; treble notes genuinely are close to sinusoidal. Rendering cost
 * is dominated by the bass, so the ceiling steps down with pitch.
 */
function partialBudget(pitch: number): number {
  if (pitch < 40) return 40;
  if (pitch < 60) return 28;
  if (pitch < 80) return 18;
  return 11;
}

export interface PartialSpec {
  /** Hz, stretched by string inharmonicity. */
  freq: number;
  phase: number;
  /** Amplitude of the fast-decaying component. */
  ampFast: number;
  /** Amplitude of the slow "aftersound" component. */
  ampSlow: number;
  tauFastSec: number;
  tauSlowSec: number;
}

/**
 * The partial series for one note.
 *
 * Real piano strings are stiff, so partial n sits above n * f0 by a factor of
 * sqrt(1 + B n^2). Getting this in is most of what separates a piano from an
 * organ by ear. Upper partials also decay faster than the fundamental, which is
 * what makes the tone darken as the note rings.
 */
export function partialsFor(pitch: number, sampleRate: number): PartialSpec[] {
  const f0 = frequencyOf(pitch);
  const tau0 = decayTauSec(pitch);
  const budget = partialBudget(pitch);
  const ceiling = Math.min(MAX_PARTIAL_HZ, sampleRate * 0.45);
  // Inharmonicity rises toward the treble, where strings are short and thick
  // relative to their length.
  const B = 0.00008 * Math.pow(2, (pitch - 48) / 18);
  // Treble notes are darker relative to their fundamental than bass notes.
  const rolloff = 0.015 + (0.05 * Math.max(0, pitch - 48)) / 48;
  const rand = rng(pitch * 2654435761);

  const partials: PartialSpec[] = [];
  for (let n = 1; n <= budget; n += 1) {
    const freq = n * f0 * Math.sqrt(1 + B * n * n);
    if (freq >= ceiling) break;

    // 1/n^1.25 series, an extra exponential rolloff, and a little per-partial
    // scatter so the spectrum is not mathematically smooth.
    const amp =
      Math.pow(n, -1.25) * Math.exp(-rolloff * (n - 1)) * (0.86 + 0.28 * rand());
    const tauSlowSec = tau0 / (1 + 0.3 * (n - 1));

    partials.push({
      freq,
      phase: rand() * Math.PI * 2,
      ampFast: amp * 0.68,
      ampSlow: amp * 0.32,
      tauFastSec: tauSlowSec * 0.28,
      tauSlowSec,
    });
  }
  return partials;
}

/** Attack ramp. Long enough to avoid a click, short enough to feel like a hammer. */
const ATTACK_TAU_SEC = 0.0016;
/** Raised-cosine fade so the buffer cannot end on a discontinuity. */
const TAIL_FADE_SEC = 0.06;
const HAMMER_SEC = 0.014;

/**
 * Render one note into a mono Float32Array.
 *
 * Partials are generated by rotating a unit phasor rather than calling
 * Math.sin per sample per partial, which is roughly an order of magnitude
 * faster and is why the whole bank builds in about a second. The phasor is
 * renormalised periodically because the rotation slowly loses magnitude.
 */
export function renderPianoSample(
  pitch: number,
  sampleRate: number
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.round(sampleDurationSec(pitch) * sampleRate));
  const out = new Float32Array(length);
  const partials = partialsFor(pitch, sampleRate);

  for (const p of partials) {
    const w = (2 * Math.PI * p.freq) / sampleRate;
    const wr = Math.cos(w);
    const wi = Math.sin(w);
    let cr = Math.cos(p.phase);
    let ci = Math.sin(p.phase);

    let envFast = p.ampFast;
    let envSlow = p.ampSlow;
    const decayFast = Math.exp(-1 / (p.tauFastSec * sampleRate));
    const decaySlow = Math.exp(-1 / (p.tauSlowSec * sampleRate));

    for (let i = 0; i < length; i += 1) {
      const nr = cr * wr - ci * wi;
      ci = cr * wi + ci * wr;
      cr = nr;
      out[i]! += ci * (envFast + envSlow);
      envFast *= decayFast;
      envSlow *= decaySlow;
      if ((i & 0x0fff) === 0x0fff) {
        const mag = Math.hypot(cr, ci);
        cr /= mag;
        ci /= mag;
      }
    }
  }

  // Hammer noise: a short lowpassed burst that gives the onset a transient the
  // partial series alone does not have.
  const rand = rng(pitch * 40503 + 7);
  const hammerLength = Math.min(length, Math.round(HAMMER_SEC * sampleRate));
  const hammerAmp = 0.1 * Math.pow(2, -(pitch - 24) / 60);
  const hammerCut = clamp(0.05, (frequencyOf(pitch) * 6) / sampleRate, 0.5);
  let lp = 0;
  for (let i = 0; i < hammerLength; i += 1) {
    lp += hammerCut * (rand() * 2 - 1 - lp);
    out[i]! += lp * hammerAmp * (1 - i / hammerLength);
  }

  // Attack ramp, applied after synthesis so every partial and the hammer share
  // one onset. Without it the buffer starts on a step and clicks.
  const attackDecay = Math.exp(-1 / (ATTACK_TAU_SEC * sampleRate));
  let a = 1;
  const attackLength = Math.min(length, Math.ceil(ATTACK_TAU_SEC * 8 * sampleRate));
  for (let i = 0; i < attackLength; i += 1) {
    out[i]! *= 1 - a;
    a *= attackDecay;
  }

  // Slow beating between the unison strings of one note. Applied globally
  // because per-partial detuning would double the render cost for an effect
  // that is only audible as a gentle waver.
  const beatHz = 0.5 + rand() * 1.1;
  const beatW = (2 * Math.PI * beatHz) / sampleRate;
  for (let i = 0; i < length; i += 1) {
    out[i]! *= 1 - 0.05 * (1 - Math.cos(beatW * i));
  }

  const fadeLength = Math.min(length, Math.round(TAIL_FADE_SEC * sampleRate));
  for (let i = 0; i < fadeLength; i += 1) {
    const x = i / fadeLength;
    out[length - 1 - i]! *= 0.5 - 0.5 * Math.cos(Math.PI * x);
  }

  normalize(out, peakTarget(pitch));
  return out;
}

/**
 * Loudness tilt across the bank. Normalising every sample to the same peak
 * makes the top octave shriek, because a near-sinusoidal treble note at peak 1
 * is far louder to the ear than a bass note with the same peak spread over 40
 * partials.
 */
function peakTarget(pitch: number): number {
  return clamp(0.4, 0.95 * Math.pow(2, -Math.max(0, pitch - 60) / 70), 0.95);
}

function normalize(buf: Float32Array<ArrayBuffer>, target: number): void {
  let peak = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = Math.abs(buf[i]!);
    if (v > peak) peak = v;
  }
  if (peak === 0) return;
  const gain = target / peak;
  for (let i = 0; i < buf.length; i += 1) buf[i]! *= gain;
}

export interface BankProgress {
  done: number;
  total: number;
  pitch: number;
}

/**
 * Render the whole bank, yielding between notes so the progress bar actually
 * paints. This runs once, behind the "start audio" gesture, and takes about a
 * second on a MacBook.
 */
export async function buildSampleBank(
  sampleRate: number,
  onProgress?: (p: BankProgress) => void,
  yieldToUi: () => Promise<void> = yieldToEventLoop
): Promise<Map<number, Float32Array<ArrayBuffer>>> {
  const bank = new Map<number, Float32Array<ArrayBuffer>>();
  for (let i = 0; i < BANK_PITCHES.length; i += 1) {
    const pitch = BANK_PITCHES[i]!;
    bank.set(pitch, renderPianoSample(pitch, sampleRate));
    onProgress?.({ done: i + 1, total: BANK_PITCHES.length, pitch });
    await yieldToUi();
  }
  return bank;
}
