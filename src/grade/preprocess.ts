/**
 * Event pre-processing shared by every grader (architecture.md section 3).
 *
 * The instrument emits note-on, note-off and a timestamp, and nothing else.
 * Everything a grader reasons about is built here, in pure functions over an
 * event array, so the same code grades a live rep and re-grades a stored one
 * from the rawMidi buffer when a tolerance changes.
 *
 * The one idea worth stating twice: a chord has two different "when"s.
 * `onsetTs` (the median member onset) is when it was *placed*, and is what
 * timing error is measured against, because the median ignores a rolled note
 * either side. `completeTs` (the last member onset) is when it was *finished*,
 * and is what latency is measured against, because you have not answered the
 * prompt until the whole chord is down.
 */

import type { NormalizedEvent } from '../midi.ts';
import { median } from '../stats.ts';

export interface Cluster {
  /** Ascending, deduplicated. */
  pitches: number[];
  /** The same pitches in the order they were struck: a roll is visible here. */
  order: number[];
  /** First member onset. */
  startTs: number;
  /** Median member onset. Timing error is measured from this. */
  onsetTs: number;
  /** Last member onset. Latency is measured to this. */
  completeTs: number;
  /** last - first. 20 to 80ms is a valid chord: recorded, never punished. */
  spreadMs: number;
  /** Ingest sequence numbers of the member note-ons, for tracing back to the log. */
  seqs: number[];
}

/**
 * Group note-ons into chords.
 *
 * A note-on starts a cluster; later note-ons join while they are within
 * `chordClusterMs` of the cluster *start* and the pitch is not already in it.
 * A repeated pitch always starts a new cluster, which is what makes a trill or
 * a re-struck note two answers rather than one wide one.
 *
 * Note-offs are ignored here. They matter to the legato grader, which measures
 * transitions rather than clusters.
 */
export function clusterNoteOns(
  events: readonly NormalizedEvent[],
  chordClusterMs: number
): Cluster[] {
  const ons = events
    .filter((e) => e.type === 'on')
    // The live stream is already ordered; a re-graded buffer might not be, and
    // one out-of-order event would silently split a chord in two.
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const clusters: Cluster[] = [];
  let onsets: number[] = [];
  let current: Cluster | null = null;

  const close = () => {
    if (!current) return;
    current.onsetTs = median(onsets);
    current.completeTs = onsets[onsets.length - 1]!;
    current.spreadMs = current.completeTs - current.startTs;
    current.pitches = [...current.order].sort((a, b) => a - b);
    clusters.push(current);
    current = null;
    onsets = [];
  };

  for (const e of ons) {
    const joins =
      current !== null &&
      e.ts - current.startTs <= chordClusterMs &&
      !current.order.includes(e.pitch);

    if (!joins) close();

    if (current === null) {
      current = {
        pitches: [],
        order: [e.pitch],
        startTs: e.ts,
        onsetTs: e.ts,
        completeTs: e.ts,
        spreadMs: 0,
        seqs: [e.seq],
      };
      onsets = [e.ts];
    } else {
      current.order.push(e.pitch);
      current.seqs.push(e.seq);
      onsets.push(e.ts);
    }
  }
  close();

  return clusters;
}

/**
 * When a cluster stops being open to more notes: the last note-on plus the
 * settle window. Expressed once so the "next cluster arrived" test and the
 * "enough silence has passed" test cannot drift apart.
 */
export function settleDeadline(cluster: Cluster, settleMs: number): number {
  return cluster.completeTs + settleMs;
}

/**
 * The answer to an untimed prompt: the first cluster followed by silence
 * (architecture.md section 4).
 *
 * `nowMs` is how far observation has got. It defaults to Infinity, meaning the
 * rep is over and no further events are coming, so grading a stored rep needs
 * no clock. Live, the runner passes the current time and gets null until the
 * user actually stops playing.
 *
 * Consequence worth knowing before it surprises someone at the keyboard: a
 * wrong chord, a pause, then the right one grades the wrong one. That is what
 * "first settled cluster" means — the pause was the answer being submitted.
 */
export function firstSettledCluster(
  clusters: readonly Cluster[],
  settleMs: number,
  nowMs: number = Infinity
): { cluster: Cluster; index: number } | null {
  for (let i = 0; i < clusters.length; i += 1) {
    const cluster = clusters[i]!;
    const deadline = settleDeadline(cluster, settleMs);
    const next = clusters[i + 1];
    const settled = next ? next.startTs > deadline : nowMs >= deadline;
    if (settled) return { cluster, index: i };
  }
  return null;
}

/**
 * Apply the app-level transpose to expected pitches (architecture.md section
 * 3.3). The user sets it when material falls outside the 61-key window; it
 * moves what is expected, never what was played, so the log stays literal.
 */
export function applyTranspose(pitches: readonly number[], semitones: number): number[] {
  return semitones === 0 ? [...pitches] : pitches.map((p) => p + semitones);
}

/**
 * Reduce pitches to the space this drill matches in: pitch classes when the
 * drill is octave-equivalent, absolute MIDI numbers otherwise. Sorted and
 * deduplicated, because both sides of a set comparison have to be sets.
 */
export function matchSpace(
  pitches: readonly number[],
  octaveEquivalent: boolean | undefined
): number[] {
  const mapped = octaveEquivalent ? pitches.map((p) => ((p % 12) + 12) % 12) : pitches;
  return [...new Set(mapped)].sort((a, b) => a - b);
}
