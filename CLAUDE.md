# CLAUDE.md

Personal MIDI piano trainer. Single user, single machine, no auth, no deploy target. Optimise for the user actually practising daily, not for generality.

## Read these before designing anything

- `docs/skill-tree.json` — the curriculum as data. 53 nodes across three tracks. Node ids, dependency edges, numeric mastery thresholds.
- `docs/session-generator.md` — how the app decides what to practise today. SM-2 variant where latency is the grade.
- `docs/architecture.md` — drill schema, grader contract, timing tolerance rules, progress data model.

These three are the source of truth. They only make sense as a set: the JSON references threshold types defined in `architecture.md` §7, and the generator references the grader contract. **If an implementation decision contradicts these docs, stop and raise it rather than silently diverging.**

## Hardware facts — verified, non-negotiable

The instrument is a **Casio CTK-2400** over USB-MIDI to a MacBook. These were confirmed from a real MIDI event log:

- **Not touch-sensitive.** Every note-on arrives at fixed velocity 100. **Never write a feature that reads velocity as expression.** No dynamics, accents, or velocity-control grading. Ever.
- **Note-offs are true status-128 messages** (release velocity 64), not note-on-with-velocity-0. Handle `0x80` explicitly. Keep the velocity-0 case as a defensive fallback.
- **All notes arrive on MIDI channel 1.** Hands are indistinguishable at the protocol level. Split hands by a **configurable pitch split point**, default C4. Never assume channel separation.
- **61 keys, 48-note polyphony.** No feature may require 88 keys.
- **Sustain is permanently ON** at the keyboard, via a panel setting. It is local to the sound engine, transmits no CC64, and does not affect the MIDI stream. The app is the sound source: keyboard volume at zero, audio out through a sampled piano in Web Audio with `latencyHint: 'interactive'`.
- **No sustain pedal.** Pedal nodes exist in the tree as `requires: ['pedal']`, permanently visible and locked.
- **Chromium only.** Web MIDI is unsupported in Safari. Do not write fallbacks.

## Stack — decided, do not re-litigate

- `webmidi.js` for MIDI I/O
- `tonal.js` for **all** music theory. Do not hand-roll interval, chord, or scale math. `Chord.detect()` already handles inversions like C/E vs C/G.
- `Tone.js` `Transport` for the clock. **Never `setInterval`** for anything musical.
- Web Audio sampled piano for output
- Local persistence (IndexedDB); retain raw MIDI for the last 20 sessions so tolerance changes can re-grade history
- Vite + React + TypeScript

**Clock gotcha:** Web MIDI timestamps and `AudioContext.currentTime` have different origins. Compute the offset once at startup and convert. Getting this wrong makes every timing score off by a constant.

## Design principles

- **Drills are data.** Every drill conforms to the schema in `architecture.md`. If adding a second drill requires touching the engine, the schema is wrong — fix the schema, not the drill.
- **One grader contract.** All drills implement it. No per-drill bespoke scoring.
- **Grade latency, not just correctness.** The user's deficit is speed, not knowledge. <1.2s automatic, 1.2–3s known, >3s not known.
- **Gamification is the skill tree.** Do not add XP, badges, or streak layers on top of it.

## V1 scope — hard stop

Ship exactly three drills, then stop and let the user practise for two weeks before building anything else:

1. Inversion trainer, latency-scored
2. Live chord-detection HUD
3. Finger legato drill

**Not in V1:** the fusion engine (it needs mastery history that does not exist yet), repertoire, sheet music, scale trainer, ear training, hand independence. They are designed, not built.

Also instrument **sessions per week** from day one. In weeks 1–2 that is the only metric that matters.

## Working style

- Vertical slices. Each slice runnable before the next begins.
- Keep the MIDI inspector screen permanently in the app as a debug route. It is the ground truth when a grader misbehaves.
- Ask before adding a dependency.
- No em dashes in generated content.
