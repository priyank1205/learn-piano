/**
 * Music theory. Every interval, chord and scale fact comes from tonal
 * (CLAUDE.md: no hand-rolled music maths). What this module adds is the part
 * tonal deliberately does not do: **placement**. tonal deals in note names and
 * pitch classes; the grader and the sampler deal in MIDI numbers, and deciding
 * which octave a named note lands in is arithmetic, not theory.
 *
 * Two rules from architecture.md are enforced by where things live in this file:
 *
 *  1. Expected pitches are built deterministically from (root, quality,
 *     inversion) through `Chord.getChord`. That is what grading compares
 *     against, and it is reproducible: the same params always give the same
 *     pitch set.
 *  2. `Chord.detect` is heuristic and is for DISPLAY ONLY — the HUD naming
 *     whatever is being played, including slash chords. Grading it would feel
 *     random. It is exported here as `detectChordNames`, named for the screen it
 *     feeds, and nothing in `grade/` imports it.
 */

import { Chord, Midi, Note } from 'tonal';

/** The two triad qualities V1 needs (skill-tree: kt-triads-root, kt-inv-*-triads). */
export type TriadQuality = 'maj' | 'min';

/** 0 = root position, 1 = first inversion, 2 = second inversion. */
export type Inversion = 0 | 1 | 2;

export const INVERSIONS: readonly Inversion[] = [0, 1, 2];

export const INVERSION_LABELS: Record<Inversion, string> = {
  0: 'root position',
  1: '1st inversion',
  2: '2nd inversion',
};

/** tonal's chord type aliases. */
const TONAL_TYPE: Record<TriadQuality, string> = { maj: 'M', min: 'm' };

/**
 * The twelve roots, spelled per quality.
 *
 * Enharmonic choice is not cosmetic: `Gbm` spells its third as Bbb and `Abm`
 * spells its as Cb, and a prompt reading "Bbb" teaches nothing about a keyboard.
 * The two lists below are the spellings that keep all 72 V1 triads free of
 * double accidentals, and they match how the chords appear on a chart.
 * `theory.test.ts` asserts that property rather than trusting this comment.
 */
export const ROOTS: Record<TriadQuality, readonly string[]> = {
  maj: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  min: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
};

/**
 * The root of a chord, spelled for its quality.
 *
 * Both lists above are chromatic from C, so the index is the pitch class. That
 * is what lets a drill's param space carry a bare pitch class and leave
 * spelling to the prompt: `Gb` and `F#` are the same item on this keyboard, and
 * making them two items would double the deck and split the practice history of
 * one physical shape in half. `theory.test.ts` asserts the ordering rather than
 * trusting it.
 */
export function rootNameOf(pc: number, quality: TriadQuality): string {
  const name = ROOTS[quality][pitchClassOf(pc)];
  if (name === undefined) throw new RangeError(`Not a pitch class: ${pc}`);
  return name;
}

/**
 * Where the reference voicing of a prompted chord is placed: bass at or above
 * MIDI 48 (C3), which keeps a second inversion inside the 61-key window with
 * room either side. Only display and playback use it — the inversion trainer is
 * octave-equivalent, so the octave a chord is *played* in is never graded.
 */
export const REFERENCE_BASS_PITCH = 48;

/** Note names, precomputed once. Two spellings; see `noteNameOf`. */
const SHARP_NAMES: readonly string[] = buildNames(true);
const FLAT_NAMES: readonly string[] = buildNames(false);

function buildNames(sharps: boolean): string[] {
  return Array.from(
    { length: 128 },
    (_, pitch) => Midi.midiToNoteName(pitch, { sharps }) || `midi${pitch}`
  );
}

/**
 * MIDI number to note name. Sharps by default because that spelling is
 * unambiguous to parse and is what the sampler keys its buffers by; flats are
 * for display next to flat-spelled chord symbols, where "C#" beside "Db/F"
 * reads as a different note.
 */
export function noteNameOf(pitch: number, opts: { sharps?: boolean } = {}): string {
  const table = opts.sharps === false ? FLAT_NAMES : SHARP_NAMES;
  return table[pitch] ?? `midi${pitch}`;
}

/** MIDI number to pitch class 0..11. Negative pitches never occur, but wrap safely. */
export function pitchClassOf(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

/**
 * Name a bare pitch class, with no octave. Octave-equivalent drills grade in
 * pitch classes, so their errors have to be reported in pitch classes too:
 * "you played G where Ab was expected" and not "G3 where Ab4 was expected",
 * which would be a note the user never played in an octave nobody asked for.
 */
export function pitchClassName(pc: number, opts: { sharps?: boolean } = {}): string {
  return noteNameOf(60 + (((pc % 12) + 12) % 12), opts).replace(/-?\d+$/, '');
}

/** Pitch class of a note name, via tonal. NaN for an unparseable name. */
export function pitchClassOfName(name: string): number {
  const chroma = Note.chroma(name);
  return chroma === undefined ? NaN : chroma;
}

/**
 * The three note names of a triad, ordered bass upward for the given inversion.
 * `Chord.getChord(type, tonic, bass)` is tonal's inversion API: it returns the
 * same chord rotated to start on `bass`.
 */
export function triadNoteNames(
  root: string,
  quality: TriadQuality,
  inversion: Inversion
): readonly string[] {
  const rootPosition = Chord.getChord(TONAL_TYPE[quality], root);
  if (rootPosition.empty) {
    throw new RangeError(`Unknown chord root: ${root}${quality === 'min' ? 'm' : ''}`);
  }
  const bass = rootPosition.notes[inversion];
  if (bass === undefined) {
    throw new RangeError(`Inversion ${inversion} does not exist in a triad`);
  }
  return Chord.getChord(TONAL_TYPE[quality], root, bass).notes;
}

/**
 * The prompt string: `Db`, `Dbm`, `Db/F`, `C#m/G#`.
 *
 * Built rather than taken from tonal's `.symbol`, which renders major as `DbM`.
 * The test asserts that every symbol this produces parses back through
 * `Chord.get` to the same notes, so the string on screen and the chord being
 * graded can never drift apart.
 */
export function chordSymbol(
  root: string,
  quality: TriadQuality,
  inversion: Inversion
): string {
  const base = `${root}${quality === 'min' ? 'm' : ''}`;
  if (inversion === 0) return base;
  return `${base}/${triadNoteNames(root, quality, inversion)[0]}`;
}

/**
 * Stack note names upward from a floor, closest voicing.
 *
 * The first name lands at or above `lowestPitch`; each later name lands at the
 * next occurrence of its pitch class above the previous note. This is the
 * octave arithmetic tonal leaves to the caller — it has no opinion about which
 * octave a pitch class belongs in.
 */
export function voicePitches(
  noteNames: readonly string[],
  lowestPitch: number
): number[] {
  const pitches: number[] = [];
  let floor = lowestPitch;
  for (const name of noteNames) {
    const chroma = pitchClassOfName(name);
    if (Number.isNaN(chroma)) throw new RangeError(`Unknown note name: ${name}`);
    // Semitones from the floor up to the next occurrence of this pitch class.
    const rise = (((chroma - floor) % 12) + 12) % 12;
    const pitch = floor + rise;
    pitches.push(pitch);
    floor = pitch + 1;
  }
  return pitches;
}

/** The reference voicing of a triad as MIDI numbers, ascending from the bass. */
export function triadPitches(
  root: string,
  quality: TriadQuality,
  inversion: Inversion,
  lowestPitch: number = REFERENCE_BASS_PITCH
): number[] {
  return voicePitches(triadNoteNames(root, quality, inversion), lowestPitch);
}

/**
 * DISPLAY ONLY (architecture.md section 2). Names whatever is sounding, slash
 * chords included, for the HUD and for the grader bench's "what you actually
 * played" line. Returns tonal's ranked candidates, best first, and an empty
 * array when fewer than three notes are held.
 *
 * Two results worth knowing before the HUD is built, both pinned in
 * `theory.test.ts`:
 *
 *  1. The ranking is not the obvious one. A first-inversion major triad is the
 *     same pitch set as a minor triad with a raised fifth, and tonal ranks that
 *     reading first, so E-G-C comes back as `['Em#5', 'CM/E']`. The slash chord
 *     is always in the list; choosing between candidates is a display decision
 *     and belongs to whatever renders them.
 *  2. Spelling is an app choice, not an observation. MIDI transmits pitch
 *     numbers, not note names, and tonal spells its answer the way the input
 *     was spelled: the same three keys are `Cm/Eb` or `Cm/D#` depending only on
 *     what this function was told to call them. `sharps` selects that, and no
 *     answer is more correct than the other without a key signature to judge it
 *     against.
 */
export function detectChordNames(
  pitches: readonly number[],
  opts: { sharps?: boolean } = {}
): string[] {
  if (pitches.length === 0) return [];
  const names = [...pitches].sort((a, b) => a - b).map((p) => noteNameOf(p, opts));
  return Chord.detect(names);
}
