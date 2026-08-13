/**
 * Tests for the theory layer.
 *
 * Two properties matter more than any individual case. First, every chord the
 * V1 decks can prompt must be spellable without double accidentals, because a
 * prompt reading "Bbb" teaches nothing about a keyboard. Second, the symbol
 * shown on screen and the pitches being graded must be the same chord: they are
 * produced by different code paths, and nothing else in the app would notice if
 * they diverged.
 */

import { describe, expect, it } from 'vitest';
import { Chord, Note } from 'tonal';
import {
  INVERSIONS,
  ROOTS,
  chordSymbol,
  detectChordNames,
  noteNameOf,
  pitchClassOf,
  rootNameOf,
  triadNoteNames,
  triadPitches,
  voicePitches,
} from './theory.ts';
import type { TriadQuality } from './theory.ts';

const QUALITIES: TriadQuality[] = ['maj', 'min'];

/** Every (root, quality, inversion) the two inversion nodes can generate. */
function everyTriad(): { root: string; quality: TriadQuality; inversion: 0 | 1 | 2 }[] {
  const out: { root: string; quality: TriadQuality; inversion: 0 | 1 | 2 }[] = [];
  for (const quality of QUALITIES) {
    for (const root of ROOTS[quality]) {
      for (const inversion of INVERSIONS) out.push({ root, quality, inversion });
    }
  }
  return out;
}

describe('root spellings', () => {
  it('covers all twelve pitch classes per quality', () => {
    for (const quality of QUALITIES) {
      const chromas = ROOTS[quality].map((r) => Note.chroma(r));
      expect(new Set(chromas).size).toBe(12);
    }
  });

  it('spells all 72 V1 triads without double accidentals', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      for (const name of triadNoteNames(root, quality, inversion)) {
        expect(name, `${root} ${quality} inv ${inversion}`).not.toMatch(/(##|bb)/);
      }
    }
  });

  /**
   * Both lists are chromatic from C, which is what lets a drill's param space
   * carry a bare pitch class and leave the spelling to the prompt. Assert it
   * rather than trusting the arrays to stay in order.
   */
  it('is indexed by pitch class', () => {
    for (const quality of QUALITIES) {
      ROOTS[quality].forEach((name, index) => {
        expect(Note.chroma(name), `${quality} ${name}`).toBe(index);
        expect(rootNameOf(index, quality)).toBe(name);
      });
    }
  });

  it('spells the same key differently per quality where it has to', () => {
    // Gb major keeps its flat; Gb minor would spell its third Bbb, so F# minor.
    expect(rootNameOf(6, 'maj')).toBe('Gb');
    expect(rootNameOf(6, 'min')).toBe('F#');
  });

  it('rejects a value that is not a pitch class', () => {
    expect(() => rootNameOf(12.5, 'maj')).toThrow(/pitch class/);
  });
});

describe('triadNoteNames', () => {
  it('rotates the chord so the inversion note is in the bass', () => {
    expect(triadNoteNames('Db', 'maj', 0)).toEqual(['Db', 'F', 'Ab']);
    expect(triadNoteNames('Db', 'maj', 1)).toEqual(['F', 'Ab', 'Db']);
    expect(triadNoteNames('Db', 'maj', 2)).toEqual(['Ab', 'Db', 'F']);
    expect(triadNoteNames('C', 'min', 1)).toEqual(['Eb', 'G', 'C']);
  });

  it('rejects an unknown root rather than returning an empty chord', () => {
    expect(() => triadNoteNames('H', 'maj', 0)).toThrow(/Unknown chord root/);
  });
});

describe('chordSymbol', () => {
  it('reads the way a chart does', () => {
    expect(chordSymbol('Db', 'maj', 0)).toBe('Db');
    expect(chordSymbol('Db', 'maj', 1)).toBe('Db/F');
    expect(chordSymbol('C', 'min', 2)).toBe('Cm/G');
    expect(chordSymbol('C#', 'min', 0)).toBe('C#m');
  });

  /**
   * The guard that matters: parse the displayed symbol back through tonal and
   * check it names the same notes in the same order. If the prompt and the
   * expected pitches ever drift apart, every rep of that item is graded against
   * a chord the user was not asked for, and nothing else would catch it.
   */
  it('round-trips through tonal for all 72 V1 triads', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      const symbol = chordSymbol(root, quality, inversion);
      const expected = triadNoteNames(root, quality, inversion);
      expect(Chord.get(symbol).notes, symbol).toEqual([...expected]);
    }
  });
});

describe('voicePitches', () => {
  it('places the bass at or above the floor and stacks upward', () => {
    // Db/F with the bass at or above C3: F3, Ab3, Db4.
    expect(voicePitches(['F', 'Ab', 'Db'], 48)).toEqual([53, 56, 61]);
  });

  it('puts a note already at the floor exactly on it', () => {
    expect(voicePitches(['C'], 48)).toEqual([48]);
  });

  it('never produces a descending voicing', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      const pitches = triadPitches(root, quality, inversion);
      const ascending = [...pitches].sort((a, b) => a - b);
      expect(pitches, chordSymbol(root, quality, inversion)).toEqual(ascending);
    }
  });

  /**
   * 61 keys, MIDI 36-96. A reference voicing that runs off the top of the
   * instrument would prompt a chord the user cannot play.
   */
  it('keeps every reference voicing inside the 61-key window', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      for (const pitch of triadPitches(root, quality, inversion)) {
        expect(pitch, chordSymbol(root, quality, inversion)).toBeGreaterThanOrEqual(36);
        expect(pitch, chordSymbol(root, quality, inversion)).toBeLessThanOrEqual(96);
      }
    }
  });

  it('agrees with tonal about which pitch classes are in the chord', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      const fromNames = triadNoteNames(root, quality, inversion).map((n) =>
        Note.chroma(n)
      );
      const fromPitches = triadPitches(root, quality, inversion).map(pitchClassOf);
      expect(fromPitches).toEqual(fromNames);
    }
  });

  it('puts the inversion note lowest', () => {
    for (const { root, quality, inversion } of everyTriad()) {
      const pitches = triadPitches(root, quality, inversion);
      const bassName = triadNoteNames(root, quality, inversion)[0]!;
      expect(pitchClassOf(pitches[0]!), chordSymbol(root, quality, inversion)).toBe(
        Note.chroma(bassName)
      );
    }
  });
});

describe('noteNameOf', () => {
  it('spells sharps by default and flats on request', () => {
    expect(noteNameOf(61)).toBe('C#4');
    expect(noteNameOf(61, { sharps: false })).toBe('Db4');
    expect(noteNameOf(60)).toBe('C4');
  });
});

describe('detectChordNames', () => {
  it('finds the slash chord for an inversion', () => {
    // G3 C4 E4: C major, second inversion.
    expect(detectChordNames([55, 60, 64])[0]).toBe('CM/G');
    // Eb3 G3 C4: C minor, first inversion.
    expect(detectChordNames([51, 55, 60], { sharps: false })[0]).toBe('Cm/Eb');
  });

  /**
   * MIDI transmits key numbers, not note names. The same three keys come back
   * spelled either way depending only on what this function was told to call
   * them, so the HUD's spelling is an app decision and cannot be read off the
   * instrument.
   */
  it('spells its answer the way the input was spelled', () => {
    expect(detectChordNames([51, 55, 60], { sharps: true })[0]).toBe('Cm/D#');
    expect(detectChordNames([51, 55, 60], { sharps: false })[0]).toBe('Cm/Eb');
  });

  /**
   * Pinning a surprise rather than hiding it. A first-inversion MAJOR triad is
   * pitch-identical to a minor triad with a raised fifth (E G C is both C/E and
   * Em#5), and tonal ranks the exotic reading first. Grading is unaffected --
   * it never calls detect -- but the chord HUD would display "Em#5" where the
   * chart says "C/E" unless it re-ranks the candidates itself. The slash chord
   * is always present in the list, which is what makes re-ranking possible.
   */
  it('ranks a first-inversion major triad under its enharmonic oddity', () => {
    expect(detectChordNames([52, 55, 60])).toEqual(['Em#5', 'CM/E']);
    expect(detectChordNames([53, 56, 61], { sharps: false })).toEqual(['Fm#5', 'DbM/F']);
  });

  it('returns nothing for fewer than three notes', () => {
    expect(detectChordNames([60])).toEqual([]);
    expect(detectChordNames([])).toEqual([]);
  });
});
