/**
 * Tests for the status-byte decoder. Every timing number the app ever produces
 * flows through this function, so it is worth pinning down before the grader
 * lands in slice 3.
 *
 * Byte sequences here match what the Casio CTK-2400 actually emits: note-on at
 * velocity 100, note-off as true 0x80 with release velocity 64, channel 1.
 */

import { describe, expect, it } from 'vitest';
import { decodeMessage, handOf, ccLabel, DEFAULT_SPLIT_POINT } from './midi.ts';

const ctx = { portId: 'test', seq: 0, now: () => 999 };
const decode = (raw: number[], ts: number | undefined = 1000) =>
  decodeMessage(raw, ts, ctx);

describe('decodeMessage', () => {
  it('decodes a note-on at the instrument velocity', () => {
    const e = decode([0x90, 60, 100]);
    expect(e).toMatchObject({
      type: 'on',
      pitch: 60,
      velocity: 100,
      channel: 1,
      ts: 1000,
      statusByte: 0x90,
    });
    expect(e?.offSource).toBeUndefined();
  });

  it('decodes a true status-128 note-off and keeps the release velocity', () => {
    const e = decode([0x80, 60, 64]);
    expect(e).toMatchObject({
      type: 'off',
      pitch: 60,
      offSource: 'status-128',
      releaseVelocity: 64,
      velocity: 0,
    });
  });

  it('treats note-on with velocity 0 as a note-off, tagged as the fallback path', () => {
    const e = decode([0x90, 60, 0]);
    expect(e).toMatchObject({ type: 'off', pitch: 60, offSource: 'velocity-0' });
    // The distinction has to survive, or the inspector cannot prove which path fired.
    expect(e?.offSource).not.toBe('status-128');
  });

  it('never reports a release velocity for the velocity-0 fallback', () => {
    // There is no third byte carrying release information on this path.
    expect(decode([0x90, 60, 0])?.releaseVelocity).toBeUndefined();
  });

  it('decodes control change including value 0', () => {
    expect(decode([0xb0, 64, 127])).toMatchObject({
      type: 'cc',
      cc: { num: 64, val: 127 },
      pitch: -1,
    });
    // Value 0 must not be confused with "no message".
    expect(decode([0xb0, 64, 0])).toMatchObject({ type: 'cc', cc: { num: 64, val: 0 } });
  });

  it('extracts the channel as 1-based from the low nibble', () => {
    expect(decode([0x90, 60, 100])?.channel).toBe(1);
    expect(decode([0x99, 60, 100])?.channel).toBe(10);
    expect(decode([0x9f, 60, 100])?.channel).toBe(16);
    // Channel must not leak into the message kind.
    expect(decode([0x8f, 60, 64])?.type).toBe('off');
    expect(decode([0xbf, 7, 100])?.type).toBe('cc');
  });

  it('drops system messages, so a clock or active sensing cannot drown the log', () => {
    expect(decode([0xf8])).toBeNull();
    expect(decode([0xfe])).toBeNull();
    expect(decode([0xf0, 0x7e, 0x7f])).toBeNull();
  });

  it('drops pitch bend, aftertouch and program change', () => {
    expect(decode([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(decode([0xa0, 60, 80])).toBeNull(); // poly aftertouch
    expect(decode([0xd0, 80])).toBeNull(); // channel aftertouch
    expect(decode([0xc0, 5])).toBeNull(); // program change
  });

  it('rejects empty and running-status messages rather than inventing an event', () => {
    expect(decode([])).toBeNull();
    // A data byte in status position: Web MIDI always delivers complete messages,
    // so this is corrupt input, not a note.
    expect(decode([60, 100])).toBeNull();
  });

  it('substitutes a clock only when the driver supplies none, and flags it', () => {
    const real = decode([0x90, 60, 100], 1234);
    expect(real?.ts).toBe(1234);
    expect(real).not.toHaveProperty('tsSynthetic');
    // A driver with no clock of its own reports 0. Timing scores would be
    // meaningless, so the substitution has to be visible.
    expect(decode([0x90, 60, 100], 0)).toMatchObject({ ts: 999, tsSynthetic: true });
    // Called directly: the helper's default argument would swallow an explicit undefined.
    expect(decodeMessage([0x90, 60, 100], undefined, ctx)).toMatchObject({
      ts: 999,
      tsSynthetic: true,
    });
  });

  it('preserves raw bytes for the inspector', () => {
    expect(decode([0x80, 60, 64])?.raw).toEqual([0x80, 60, 64]);
  });

  it('tolerates a truncated message by zero-filling the missing data byte', () => {
    // Better a gradable event with velocity 0 than a thrown exception mid-session.
    expect(decode([0x90, 60])).toMatchObject({ type: 'off', offSource: 'velocity-0' });
  });
});

describe('handOf', () => {
  it('splits at the configured point, with the split note itself in the right hand', () => {
    expect(handOf(59, DEFAULT_SPLIT_POINT)).toBe('L');
    expect(handOf(60, DEFAULT_SPLIT_POINT)).toBe('R');
    expect(handOf(61, DEFAULT_SPLIT_POINT)).toBe('R');
  });

  it('honours a moved split point', () => {
    expect(handOf(60, 65)).toBe('L');
    expect(handOf(65, 65)).toBe('R');
  });
});

describe('ccLabel', () => {
  it('names known controllers and falls back to the bare number', () => {
    expect(ccLabel(64)).toBe('Sustain Pedal');
    expect(ccLabel(7)).toBe('Channel Volume');
    expect(ccLabel(121)).toBe('Reset All Controllers');
    expect(ccLabel(3)).toBe('CC3');
  });
});
