/**
 * Tests for the MIDI-to-audio routing rules.
 *
 * The firewall tests are the point of this file. CC64 blocking cannot be
 * verified by ear (the instrument sends no CC64 today) and cannot be verified
 * by the inspector (which shows the event stream, where CC is supposed to
 * appear). A test is the only place it can be pinned down before a pedal
 * arrives and the default sampler behaviour quietly breaks the legato drill.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AudioOut, DRY_RELEASE_SEC, shouldReachAudio } from './engine.ts';
import type { PianoVoice } from './engine.ts';
import type { NormalizedEvent } from '../midi.ts';

let seq = 0;

function noteOn(pitch: number, ts = 1000): NormalizedEvent {
  return {
    type: 'on',
    pitch,
    ts,
    velocity: 100,
    channel: 1,
    statusByte: 0x90,
    raw: [0x90, pitch, 100],
    seq: seq++,
    portId: 'test',
  };
}

function noteOff(pitch: number, ts = 1200): NormalizedEvent {
  return {
    type: 'off',
    pitch,
    ts,
    velocity: 0,
    releaseVelocity: 64,
    channel: 1,
    statusByte: 0x80,
    raw: [0x80, pitch, 64],
    seq: seq++,
    portId: 'test',
    offSource: 'status-128',
  };
}

function cc(num: number, val: number, ts = 1000): NormalizedEvent {
  return {
    type: 'cc',
    pitch: -1,
    ts,
    velocity: 0,
    channel: 1,
    cc: { num, val },
    statusByte: 0xb0,
    raw: [0xb0, num, val],
    seq: seq++,
    portId: 'test',
  };
}

/** Records every call the engine makes, so "did this reach the audio path" is decidable. */
class SpyVoice implements PianoVoice {
  calls: string[] = [];
  releaseSeconds = 0;
  attack(pitch: number) {
    this.calls.push(`attack:${pitch}`);
  }
  release(pitch: number) {
    this.calls.push(`release:${pitch}`);
  }
  releaseAll() {
    this.calls.push('releaseAll');
  }
  setReleaseSeconds(seconds: number) {
    this.releaseSeconds = seconds;
    this.calls.push(`setRelease:${seconds}`);
  }
}

let voice: SpyVoice;
let clock: { nowMs: number; contextTime: number; offsetMs: number | null };
let audio: AudioOut;

beforeEach(() => {
  seq = 0;
  voice = new SpyVoice();
  clock = { nowMs: 1005, contextTime: 20, offsetMs: 4321.5 };
  audio = new AudioOut({
    nowMs: () => clock.nowMs,
    contextTime: () => clock.contextTime,
    offsetMs: () => clock.offsetMs,
  });
  audio.attachVoice(voice);
  voice.calls = [];
});

describe('shouldReachAudio', () => {
  it('passes note events', () => {
    expect(shouldReachAudio(noteOn(60))).toBe(true);
    expect(shouldReachAudio(noteOff(60))).toBe(true);
  });

  it('blocks every control change, whatever the controller', () => {
    expect(shouldReachAudio(cc(64, 127))).toBe(false);
    expect(shouldReachAudio(cc(64, 0))).toBe(false);
    expect(shouldReachAudio(cc(7, 100))).toBe(false);
    expect(shouldReachAudio(cc(1, 64))).toBe(false);
    expect(shouldReachAudio(cc(123, 0))).toBe(false);
  });
});

describe('the CC64 firewall', () => {
  it('never touches the voice for a sustain-pedal-down message', () => {
    audio.handleEvent(cc(64, 127));
    expect(voice.calls).toEqual([]);
  });

  it('still damps a note-off while CC64 says the pedal is down', () => {
    // This is the failure being prevented: a sampler that honoured CC64 would
    // hold this note past its note-off and the legato drill would measure
    // something the user cannot hear.
    audio.handleEvent(cc(64, 127));
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOff(60));
    expect(voice.calls).toEqual(['attack:60', 'release:60']);
  });

  it('counts what it blocked, separating CC64 from the rest', () => {
    audio.handleEvent(cc(64, 127));
    audio.handleEvent(cc(64, 0));
    audio.handleEvent(cc(7, 90));
    audio.handleEvent(cc(121, 0));
    expect(audio.counters.ccBlocked).toBe(4);
    expect(audio.counters.cc64Blocked).toBe(2);
  });

  it('keeps blocked CC out of the note trace, which is a record of sound made', () => {
    audio.handleEvent(cc(64, 127));
    expect(audio.trace()).toHaveLength(0);
  });
});

describe('note routing', () => {
  it('sounds a note on note-on and damps it on note-off in dry mode', () => {
    audio.handleEvent(noteOn(60));
    expect(audio.keysDown.has(60)).toBe(true);
    audio.handleEvent(noteOff(60));
    expect(voice.calls).toEqual(['attack:60', 'release:60']);
    expect(audio.keysDown.has(60)).toBe(false);
  });

  it('sets a damper-like release time when the voice is attached', () => {
    const fresh = new AudioOut({
      nowMs: () => 0,
      contextTime: () => 0,
      offsetMs: () => 0,
    });
    const v = new SpyVoice();
    fresh.attachVoice(v);
    expect(v.releaseSeconds).toBe(DRY_RELEASE_SEC);
  });

  it('retriggers rather than swallowing a repeated note-on', () => {
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOn(60));
    expect(voice.calls).toEqual(['attack:60', 'attack:60']);
    expect(audio.counters.attacks).toBe(2);
  });

  it('counts a note-off with no matching note-on instead of hiding it', () => {
    audio.handleEvent(noteOff(60));
    expect(audio.counters.orphanOffs).toBe(1);
    // It is still released: better a redundant release than a stuck note.
    expect(voice.calls).toEqual(['release:60']);
  });

  it('survives having no voice attached, so MIDI works before audio is started', () => {
    const silent = new AudioOut({
      nowMs: () => 0,
      contextTime: () => 0,
      offsetMs: () => null,
    });
    expect(() => {
      silent.handleEvent(noteOn(60));
      silent.handleEvent(noteOff(60));
      silent.panic();
    }).not.toThrow();
    expect(silent.counters.attacks).toBe(1);
  });
});

describe('sustained mode', () => {
  beforeEach(() => {
    audio.setMode('sustained');
    voice.calls = [];
  });

  it('lets notes ring through their note-off', () => {
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOff(60));
    expect(voice.calls).toEqual(['attack:60']);
    expect(audio.counters.releasesSuppressed).toBe(1);
    expect(audio.counters.releases).toBe(0);
  });

  it('still tracks which keys are physically down', () => {
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOff(60));
    expect(audio.keysDown.size).toBe(0);
  });

  it('damps the ringing tail when switching back to dry, keeping held keys sounding', () => {
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOff(60));
    audio.handleEvent(noteOn(67));
    voice.calls = [];

    audio.setMode('dry');
    // 60 was released and must stop ringing; 67 is still held and must not.
    expect(voice.calls).toEqual(['releaseAll', 'attack:67']);
  });

  it('ignores a redundant mode set', () => {
    audio.setMode('sustained');
    expect(voice.calls).toEqual([]);
  });
});

describe('the note trace', () => {
  it('places each event on the audio clock through the calibrated offset', () => {
    clock.offsetMs = 4321.5;
    audio.handleEvent(noteOn(60, 14321.5));
    const [entry] = audio.trace();
    expect(entry?.contextTime).toBeCloseTo(10, 9);
  });

  it('reports driver-to-app dispatch lag', () => {
    clock.nowMs = 1007.5;
    audio.handleEvent(noteOn(60, 1000));
    expect(audio.trace()[0]?.dispatchMs).toBeCloseTo(7.5, 9);
  });

  it('reports key-to-speaker latency, derived through the offset', () => {
    // Offset says context time 20s corresponds to performance time 24321.5ms.
    // A key pressed at 24300ms therefore reaches the speaker 21.5ms later.
    clock.offsetMs = 4321.5;
    clock.contextTime = 20;
    audio.handleEvent(noteOn(60, 24300));
    expect(audio.trace()[0]?.toSpeakerMs).toBeCloseTo(21.5, 9);
  });

  it('records nothing until the clock has been calibrated', () => {
    clock.offsetMs = null;
    audio.handleEvent(noteOn(60));
    expect(audio.trace()).toHaveLength(0);
    // The sound still happens; only the measurement is withheld.
    expect(voice.calls).toEqual(['attack:60']);
  });

  it('medians key-to-speaker latency over note-ons only', () => {
    clock.offsetMs = 0;
    clock.contextTime = 1; // maps to performance time 1000ms
    audio.handleEvent(noteOn(60, 990)); // 10ms
    audio.handleEvent(noteOn(62, 980)); // 20ms
    audio.handleEvent(noteOn(64, 970)); // 30ms
    audio.handleEvent(noteOff(60, 500)); // 500ms, must not drag the median
    expect(audio.medianToSpeakerMs()).toBeCloseTo(20, 9);
  });

  it('returns null for the median with nothing played yet', () => {
    expect(audio.medianToSpeakerMs()).toBeNull();
  });

  it('keeps the trace bounded during a long session', () => {
    for (let i = 0; i < 500; i += 1) audio.handleEvent(noteOn(60 + (i % 12)));
    expect(audio.trace().length).toBeLessThanOrEqual(40);
  });
});

describe('panic', () => {
  it('silences everything and forgets which keys were down', () => {
    audio.handleEvent(noteOn(60));
    audio.handleEvent(noteOn(64));
    voice.calls = [];
    audio.panic();
    expect(voice.calls).toEqual(['releaseAll']);
    expect(audio.keysDown.size).toBe(0);
  });
});
