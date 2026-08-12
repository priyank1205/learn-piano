# Architecture Spec

Scope: the runtime that turns MIDI events into graded reps. Stack is fixed (webmidi.js, tonal.js, Tone.js Transport, sampled piano via Web Audio, local persistence). Everything below is buildable from note-on, note-off, and timestamps — the only three facts this instrument emits.

---

## 1. Module map

```
webmidi.js ──> MidiIngest ──> NoteStream (normalized events, DOMHighRes ts)
                                  │
              Tone.Transport ─────┼──> SessionRunner (queue from session-generator)
                                  │         │ per item:
                                  │         ├─ PromptRenderer (text / chord symbol / notation-lite / audio)
                                  │         ├─ AudioOut (dry sampled piano; echoes his playing +
                                  │         │            plays ear prompts; keyboard volume is 0)
                                  │         └─ Grader (one contract, §5)
                                  │                 │
                                  └────────────> Store (IndexedDB, §8) ──> SchedulerState
```

Normalized event: `{ type: 'on'|'off'|'cc', pitch: 0-127, ts: DOMHighResTimeStamp, cc?: {num, val} }`. Velocity is captured but never graded (always 100). CC64 is captured now so pedal nodes work the day a pedal appears.

---

## 2. Drill schema — drills are data

```ts
interface DrillTemplate {
  id: string;
  nodeIds: string[];                       // skill-tree nodes this drill can exercise
  promptMode: 'text' | 'chord-symbol' | 'notation-lite' | 'audio';
  answerMode: 'play' | 'choice';           // 'choice' exists so ear skills can be measured
                                           // without keyboard fluency contaminating them (§10)
  paramSpace: Record<string, (string|number)[]>;
      // e.g. { root: 12 pcs, quality: ['maj','min'], inversion: [0,1,2] }
      // itemId = stableHash(templateId + params). The cartesian product IS the item pool.
  buildExpected: (params) => ExpectedPerformance;   // uses tonal.js only — no custom chord math
  grading: { graderId: 'set' | 'sequence' | 'legato' | 'sync' | 'piece' | 'pedal';
             weights?: { identity: number; timing: number; articulation: number };  // default .6/.25/.15
             tolerances?: Partial<Tolerances> };
  constraints: {
    splitPoint?: number;                   // default 60; hands indistinguishable otherwise
    octaveEquivalent?: boolean;            // chord-ID: any octave ok
    octaveShiftAllowed?: boolean;          // whole expected pattern may transpose ±12/±24 (61-key reality)
    inversionStrict?: boolean;             // lowest sounding pc must equal expected bass pc
    tempoBpm?: number;
  };
}

interface ExpectedPerformance {
  events: ExpectedEvent[];                 // ordered
  tempoBpm?: number;                       // present => timed grading
}
interface ExpectedEvent {
  pitches: number[];                       // MIDI numbers; or pitch classes when octaveEquivalent
  atBeat?: number;                         // omitted for untimed (flashcard-style) drills
  hand?: 'L' | 'R';
  bassPc?: number;                         // for inversionStrict events
}
```

Adding a drill = writing a `DrillTemplate` object. New grader code is needed only for a genuinely new metric family; the six graders above cover every node in the tree.

`Chord.detect()` from tonal is used for the **HUD display** (naming whatever he plays, incl. slash chords) — never for grading. Grading always compares against `buildExpected` output deterministically; detect() is heuristic and would make grading feel random.

---

## 3. Event pre-processing (shared by all graders)

1. **Hand partition** (if the drill declares hands): pitch < splitPoint → L, else R. Specs whose expected events cross the split are **rejected at authoring time** — hand-crossing is ungradable on this instrument and no drill may require it.
2. **Chord clustering:** a note-on starts a cluster; subsequent note-ons join while `ts − clusterStart ≤ chordClusterMs (80)` and the pitch isn't already in the cluster. Cluster properties:
   - `onsetTs` = **median** member onset (used for timing error — robust to rolls)
   - `completeTs` = last member onset (used for latency — you haven't answered until the whole chord is down)
   - `spreadMs` = last − first (rolled-chord magnitude; 20–80ms is a valid chord, recorded not punished)
3. **Octave shift:** if `octaveShiftAllowed`, the app-level transpose offset (user sets ±12/±24 when material exceeds the 61-key window) is applied to expected pitches before matching.

---

## 4. Matching: wrong vs. late vs. missing

This is where naive implementations feel unfair. Rules:

```
Tolerances {
  chordClusterMs: 80
  timingWindowMs(IOI) = clamp(40, 0.25 * IOI, 120)    // IOI = 60000 / (bpm * notesPerBeat)
  lateFactor: 2            // within ±W on-time; ±W..±2W late/early; beyond = miss
  legatoBandMs: [10, 60]
  detachedGapMs: -20       // overlap below this = detached
  smearMs: 120             // overlap above this = held-over
  staccatoDuty: [0.3, 0.5]
}
```

**Timed drills** (expected grid from Transport at the drill tempo):

1. Walk expected events in order. For each, search played clusters in `[t − 2W, t + 2W]`.
2. A cluster with the **correct pitch set** inside `±W` → matched on-time. Inside `±2W` → matched, flagged `late`/`early`, timing error recorded, small score penalty — **not a wrong note**.
3. A cluster inside `±W` with wrong pitches, when no correct cluster exists in the window → **wrong note(s)** attributed to that slot (`{expected, played}` pairs by nearest pitch).
4. Expected event with no candidate in `±2W` → **missing**. Played cluster matching nothing → **extra**.
5. Greedy in time order, each cluster consumed once. (DTW is overkill at these tempos; revisit only if repertoire grading misbehaves at high speed.)

Windows scale with tempo *through IOI*, with a 40ms floor (below human relevance) and 120ms ceiling (above it, slow tempos would forgive rhythm entirely).

**Untimed drills** (flashcards — inversion trainer, chord-play, theory-recall): no grid. Grade the first *settled* cluster (no new note-ons for 300ms) after prompt: set equality (octave-equivalent if declared) + `inversionStrict` check: lowest sounding pitch-class must equal `bassPc`. Everything else = wrong, itemized.

---

## 5. Grader contract

```ts
interface Grader {
  grade(events: NormalizedEvent[], spec: DrillInstance): GradeResult;
}

interface GradeResult {
  correct: boolean;              // per node's accuracy definition
  score: number;                 // 0..1 weighted (identity/timing/articulation weights from template)
  latencyMs: number | null;      // untimed drills: promptReadyAt -> answer cluster completeTs
                                 // timed drills: null (bands don't apply; see session-generator §2)
  timingErrorMs: { mean, meanAbs, sd } | null;      // matched onsets vs grid
  noteOverlapMs: { hand: 'L'|'R', transitions: number[] }[] | null;
                                 // per melodic transition: off(n) − on(n+1); +ve = overlap, −ve = gap
  noteErrors: { missing: number[]; extra: number[]; wrong: {expected:number, played:number}[] };
  spreadMsMax: number | null;    // worst rolled-chord spread this rep
  handOnsetSkewMs: number | null;// hands-together drills: |median R onset − median L onset| per pair, meanAbs
  perEvent: EventGrade[];        // full detail for UI playback / fusion decomposition
  raw: NormalizedEvent[];        // kept for re-grading (§8)
}
```

- **`promptReadyAt`** = render complete for visual prompts; **end of audio playback** for ear prompts. Latency never includes listening time.
- **Overlap** is computed per hand on monophonic lines: for consecutive melodic notes n, n+1: `overlap = off(n) − on(n+1)`. Classification: `< −20ms` detached · `−20..+10` near-legato · `+10..+60` **target band** · `+60..+120` smeared · `> +120` held-over (the sustain crutch made visible). Thumb-under transitions in scale drills are indexed by scale position under standard fingering and reported as a separate share.
- **Articulation duty** = `duration(n) / IOI` — measurable to 0.1ms because note-offs are true status-128 messages.
- **Fusion decomposition** (session-generator §5.4): the SessionRunner maps `GradeResult` fields to component items — `noteErrors` on chord events → chord-form/harmony items; `timingErrorMs` → rhythm item; `noteOverlapMs` → legato item. Each component gets its own sub-correctness rep.

Latency band boundaries (1200/3000ms) live in one config object, not scattered.

---

## 6. What is deliberately NOT graded

- **Anything velocity-based.** No dynamics, accents, phrasing-by-volume, ghost notes. Not deferred — impossible on this hardware, absent from the tree.
- **Hand-crossing material.** Rejected at drill-authoring time.
- **Acoustic legato.** Only mechanical (MIDI) legato is graded; the dry sampled piano exists so his ears can audit what the grader measures. Every `sustainSensitive: true` node MUST route playback through the app piano.

---

## 7. Mastery threshold types (referenced by skill-tree.json)

| type | fields | correct := |
|---|---|---|
| `deckFluency` | accuracy, automaticShare, minRepsPerItem | set/inversion match; node complete when `automaticShare` of items have latEMA < 1200ms |
| `timedRun` | tempoBpm, notesPerBeat, noteAccuracy, meanAbsErrMsMax?, timingSdMsMax, handOnsetSkewMsMax?, cleanPasses, perHand? | all notes matched, stats under maxima |
| `legato` | tempoBpm, overlapBandMs, inBandShare, thumbUnderInBandShare?, cleanPasses | clean notes AND inBandShare met |
| `articulation` | dutyBand, inBandShare, ... | clean notes AND duty share met |
| `sync` | tempoBpm, chordAccuracy, onsetWindowMs, timingSdMsMax?, cleanPasses, chartsRequired?/perKeyCoverage? | chord identity + placement within window |
| `voiceLeading` | voiceMotionTotalMax, maxUpperVoiceLeapSemitones, changeLatencyMsMax, accuracy | chords correct AND, pairing upper voices by pitch order across each change, Σ|semitone motion| ≤ max and no upper voice leaps > max |
| `earDeck` | accuracy, windowItems, medianResponseMsMax | answer matches; rolling window |
| `dictation` | noteAccuracy, chordAccuracy?, rhythmAccuracy?, maxListens, windowItems | reproduction matches per-field |
| `piece` | noteAccuracy, tempoShareOfTarget, cleanPasses | vs reference MIDI via the `sequence` grader |
| `pedalSync` | cc64WindowMs / liftWindowMsAfterOnset, redepressWithinMs, cleanChangeShare | CC64 timing vs harmony-change onsets |

Every metric above reduces to note-on, note-off, timestamp (and CC64 for pedal). Nothing else exists.

---

## 8. Progress data model

```
IndexedDB (localForage), schemaVersion at root:

itemState     : keyed by itemId — the SRS fields (session-generator §1.1). Authoritative.
repLog        : append-only. {ts, sessionId, itemId, drillId, rating, correct, latencyMs,
                 timingStats, inBandShare?, fusedFrom?: exerciseId}. Authoritative.
sessionLog    : {id, startTs, durationMin, plannedBudget, trackMinutes, rollingAccuracy}
rawMidi       : ring buffer, last 20 sessions of full NormalizedEvent streams + drill boundaries.
                Exists so tolerance changes (they WILL change in weeks 1–2) can re-grade
                recent history instead of poisoning it.
settings      : splitPoint, hasPedal, presets, targetShares, latency band config, transpose offset
```

**Reconstructable, never authoritative:** nodeMastery, unlock state, track shares, governor stats, charts — all derivable from `repLog` + the tree. Cache them with the tree's `version`; rebuild on any mismatch.

**Durability:** call `navigator.storage.persist()` at first run (Chrome can evict IndexedDB otherwise — losing this data is a motivation-killer, which makes it an adherence bug, not a data bug). One-tap JSON export/import of all stores; nudge a backup once a week.

---

## 9. Numbers most likely wrong / watch in the first two weeks

1. **Legato band [10, 60]ms and the stage thresholds.** Calibrated off one captured log showing ~60ms overlaps. If stage 1 feels impossible or trivial, recalibrate from his own distribution: set the band edges at his current p25/p75 and walk them toward [10, 60] over sessions. The *direction* (measure overlap, shrink smear) is safe; the numbers aren't.
2. **Timing windows (0.25×IOI, 40–120ms clamp).** If graded rhythm feels unfair, log the distribution of |timing error| on passes he *self-reports* as good and set W at its p90. The rawMidi buffer exists precisely for this.
3. **The global latency bands (1.2s / 3s).** A 4-note D♭maj7 3rd-inversion is not comparable to naming a note. If big chords never reach "automatic", scale the automatic threshold by answer size: `1200ms + 150ms × (notes − 1)` is the first thing to try.
4. **Ordering uncertainties** — enumerated in `skill-tree.json.orderingUncertainties`, each with its resolution trigger. The two highest-stakes: circle-of-fifths placement (index 1) and functional-vs-intervallic ear order (index 2).
5. **Ear-by-playing conflation.** Answering ear drills on the keyboard doubles as keyboard training, but if ear accuracy correlates with *key familiarity* (worse in Db than C), keyboard latency is contaminating the ear signal — switch those decks to `answerMode: 'choice'` and re-baseline.
6. **Adherence mechanics (22:00 default, re-entry, last-item rule)** are hypotheses about one specific human. The metric that decides everything: **sessions per week, weeks 1–2.** ≥5 → the design is holding. ≤3 → don't tune thresholds, shrink the default session to 10 min and make the warm-up the whole front half. The tree can be wrong for months and recover; the habit can't.
7. **Fusion difficulty predictor** (product of accuracies ≥ 0.7) — log predicted vs actual fusion success from day one; refit the constant after ~30 fusions.
