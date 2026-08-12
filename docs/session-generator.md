# Session Generator

The algorithm that decides what gets practiced today. Everything here is implementable from the data structures in `architecture.md` and the node definitions in `skill-tree.json`.

Design stance: **latency is the primary learning signal, adherence is the primary constraint.** He already *knows* most of the early material — the scheduler's job is to convert knowledge into speed, and to survive being opened at 11pm on a Tuesday.

---

## 1. State

### 1.1 Item state (the unit spaced repetition operates on)

An **item** is the smallest gradable unit a node generates — "Db major, 1st inversion", "Eb major scale, LH", "interval: m6 descending". Item ids are stable hashes of `(nodeId, params)`.

```
ItemState {
  itemId, nodeId
  status: 'new' | 'learning' | 'review' | 'suspended'   // suspended = leech
  ease: float          // start 2.3, clamp [1.3, 2.9]
  intervalDays: float
  dueAt: timestamp
  reps: int, lapses: int
  accEMA: float        // exponential moving accuracy, alpha 0.3
  latEMA: float        // exponential moving latencyMs, alpha 0.3
  history: ring buffer of last 10 {ts, rating, correct, latencyMs}
}
```

### 1.2 Node state — **derived, never stored authoritatively**

```
itemMastered(item, node) :=
  last 3 reps all correct
  AND accEMA >= node.threshold accuracy
  AND latEMA inside the node's latency/tempo target
    (deckFluency: latEMA < 1200ms; timedRun/legato/sync: last pass met the numeric threshold)

nodeMastery(node) := count(itemMastered) / itemCount     // 0..1
nodeComplete(node) := threshold met per its type
                       (deckFluency: automaticShare reached; timedRun: cleanPasses
                        recorded for every item; etc.)
```

### 1.3 Node lifecycle

```
locked -> unlocked -> learning -> complete -> maintenance
```

- **Unlock rule:** every dep at `nodeMastery >= 0.80` AND all `requires` satisfied (pedal flag lives in settings). 0.8, not 1.0 — completion tails shouldn't block the frontier.
- **learning:** node is in an active slot (see §3) and receives new items.
- **complete:** threshold met once. Items stay in SRS forever (maintenance); the node stops occupying a slot.
- Nodes never *re-lock*, but a maintenance node whose mastery decays below 0.6 raises a **decay flag** that boosts its items' priority (§4).

---

## 2. Updating from drill results

Every graded rep maps to an SM-2-style rating. **Correctness gates, latency grades:**

| Result | Rating |
|---|---|
| Incorrect (missing/wrong notes, or timing fail per grader) | `again` |
| Correct, latency > 3000ms (band: not known) | `hard` |
| Correct, 1200–3000ms (band: known) | `good` |
| Correct, < 1200ms (band: automatic) | `easy` |

For tempo/pass drills (scales, legato, sync) latency bands don't apply; instead: clean pass at target = `good`, clean pass exceeding target (higher tempo tier) = `easy`, pass with threshold misses but no note errors = `hard`.

**Scheduling update:**

```
again: lapses+1; ease -= 0.20; interval = max(1, interval * 0.3)
       status = learning; re-queue THIS session after 3–6 other items,
       then again next session
hard:  ease -= 0.15; interval *= 1.2
good:  interval *= ease
easy:  ease += 0.10; interval *= ease * 1.3

learning steps (new or lapsed items): [in-session re-queue, next session] -> graduate at interval 1d (2d if easy)
interval caps by track:  physical-rhythm 14d | ear 30d | keyboard-theory 45d
   (motor skills decay faster than declarative recall — the caps are guesses; see architecture.md §10)
interval fuzz: ±15% random, so decks don't clump onto the same day
EMA updates: accEMA, latEMA with alpha 0.3 on every rep
```

Reps that arrive as **components of a fused exercise** (§5) update `accEMA` and scheduling, but **not** `latEMA` — latency is only meaningful for the dimension that was actually prompted.

Reps harvested from **free-play HUD mode** (§8) update `latEMA` only, with alpha 0.1 — low-trust telemetry, never scheduling.

---

## 3. Which nodes are in play

The generator maintains an **active set**:

- All `learning` nodes, capped at **2 per track, 5 total** (WIP limit).
- When a slot frees (a node completes), promote the unlocked node with the highest priority:
  1. `isV1` nodes first
  2. then by descendant count (unlocks the most future tree)
  3. user pin overrides everything (he can always choose)
- **Load guard:** never promote a new node if yesterday's session accuracy was < 75%. Don't add weight to a struggling week.
- **New-item faucet:** max **8 new items/day** across all nodes (0 in re-entry mode, §6). New items always enter via the learning steps.

---

## 4. Item selection within a session

```
duePool   = items with dueAt <= now, status != suspended
priority(item) = sqrt(overdueDays + 1)
               * nodeWeight        // learning node 1.5, decay-flagged 1.3, maintenance 1.0
               * leechShadow       // 0.5 if lapses >= 5 (still served, less often)
selection = softmax-weighted sampling over priority, temperature 0.7
```

Sampling, not strict priority order — deterministic order is how "the same items forever" happens.

**Variety guard:** an item appears at most twice per session (its learning-step re-queue is the second).

---

## 5. Combination engine

The generator fuses mutually reinforcing weaknesses into one exercise instead of serving three isolated drills.

### 5.1 Exercise slots

Every fusable exercise is a template with independent dimensions:

| Slot | Fed by nodes |
|---|---|
| key / harmony | kt-scales-*, kt-circle-of-fifths, kt-diatonic-chords, kt-numeral-progressions |
| chord form | kt-inv-*, kt-7ths-*, kt-*-voicings |
| LH pattern | pr-lh-patterns, pr-alberti |
| rhythm / subdivision | pr-subdivisions, pr-rhythm-independence |
| tempo | modifier, not a node |

Example fusion: **"I–V–vi–IV in G, first inversions, LH eighth root-fifth, 76 BPM"** — one exercise crediting three items.

### 5.2 Combinable when ALL of:

1. The candidate weak items map to **different slots** (two inversion items can't fuse — same slot).
2. **At most ONE slot is 'learning'**; every other slot is at `good`-or-better band (rolling accuracy ≥ 0.85 over last 10 reps). The one-new-thing rule.
3. **Predicted success ≥ 0.70**, estimated as the product of each component's rolling accuracy. Crude but computable; recalibrate from logged fusion outcomes after ~2 weeks.
4. Not both hands carrying new material simultaneously (new LH pattern × new RH chord form is forbidden even if 1–3 pass).
5. Tempo = `0.9 × min(mastered tempo across components)` — a fusion never runs faster than its slowest component's proven tempo.

### 5.3 Never fuse

- Ear dictation × any unlearned physical element (can't attribute the error).
- Legato-precision items × unlearned harmonic material (release timing collapses when the notes are being computed).
- Anything that puts **two** `learning`-status items in one exercise.

### 5.4 Grading a fusion

The grader (architecture.md §5) decomposes: chord-identity errors → the chord-form/harmony items; onset deviation stats → the rhythm item; overlap stats → any legato item. Each component gets a rep with its own sub-correctness. Latency updates only the prompted slot (§2).

---

## 6. Session assembly

```
budget = user preset (5 | 10 | 15 | 25 min), default 15
         after 22:00 local: default drops to 10 min, review-only
         (override is one tap — the point is a lower default activation energy, not a rule)

structure:
  1. WARM-UP (90s): one maintenance physical item at -20% tempo. Always a guaranteed win.
  2. BLOCKS of 2–4 min, alternating tracks until budget spent:
       nextTrack = argmax( targetShare - actualShare(rolling 7 days, minutes) )
       targetShare default: KT 0.40 | PR 0.35 | EAR 0.25
       constraints: every track gets >= 1 block when budget >= 10 min;
                    ear <= 5 min per session (fatigue), >= 3 min when budget >= 15
  3. per block: try one fusion (§5) first; fill remainder from §4 selection;
     up to 20% of block items may be NEW (respecting the daily faucet and the governor)
  4. LAST ITEM RULE: the final item of every session is drawn from the user's
     top-decile accEMA items. End on competence. (Adherence, again.)
```

**Minimum viable session = 5 minutes and counts fully.** The generator never displays a deficit, owed backlog, or broken anything. The only visible currency is node mastery on the tree.

---

## 7. Skip handling

| Gap | Behaviour |
|---|---|
| 1–3 days | Normal. Backlog compression: serve at most `1.5 × session capacity` due items; silently postpone the rest by extending their interval by the overdue amount (no penalty, no message). |
| 4–7 days | Session auto-preset 10 min; mix shifts to 70% maintenance / 30% learning; no new items on day one back. |
| > 7 days | **Re-entry mode**, 2 sessions: 10 min, only the user's *strongest* items (top-half accEMA), zero new items, thresholds displayed one band relaxed. Purpose: rebuild the habit before rebuilding the skill. Exit automatically after 2 sessions. |

Re-entry is the single most important adherence mechanism in this spec. The failure pattern for self-built tools is: skip a week → open app → get punished by a wall of due items → close app forever. Re-entry makes the return session the *easiest* session.

---

## 8. Free-play harvest

The chord HUD has a passive mode: no prompts, he plays charts exactly as he does today. The HUD logs `(detected chord, timestamp)` pairs. Chords whose *change latency* (gap between successive chart chords vs. the chart's grid) is consistently slow get their corresponding items' `latEMA` nudged (alpha 0.1). His existing habit becomes the scheduler's reconnaissance — the app earns value from him **before** demanding anything.

---

## 9. Difficulty governor & failure modes

Target: **rolling session accuracy 80–85%** (last 30 graded reps, across sessions).

| Symptom | Response |
|---|---|
| accuracy < 70% | Inject maintenance items until back over 75%; drop fusion tempo 10%; pause the new-item faucet |
| accuracy > 92% for 2 consecutive sessions | Advance: open the faucet wider (12/day), raise timedRun tempo targets by 8% for at-threshold items |
| "only easy served" | Structurally prevented: each session must include ≥ 20% of items from the bottom accuracy-quartile of active nodes (unless in re-entry) |
| "only hard served" | The governor floor above, plus the warm-up and last-item rules |
| "same items forever" | Softmax sampling (§4) + variety guard + interval fuzz |
| Leech (lapses ≥ 8) | Suspend from auto-queue; generate a remedial variant (half tempo, isolated hand, or split into sub-steps) as a *new temporary item*; surface once in UI: "this one needs a different approach" — never re-serve the failing form silently |

---

## 10. Numbers most likely to need tuning (watch weeks 1–2)

- Interval caps per track (14/30/45d) — pure guesses.
- Fusion success predictor (product of accuracies) — will over- or under-estimate; log predicted vs. actual and refit.
- 22:00 review-only default and re-entry thresholds — hypotheses about *his* behaviour; keep them settings, not constants.
- The 8-item/day new faucet — if early nodes clear as fast as expected (he knows this material), 8 will feel throttled; consider 12 for deckFluency nodes only.
