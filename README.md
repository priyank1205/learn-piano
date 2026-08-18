# learn-piano

Personal MIDI piano trainer for a Casio CTK-2400 over USB. Single user, single
machine, no auth, no deploy.

The design is specified in three documents, which are the source of truth:

- `docs/skill-tree.json` (the curriculum as data)
- `docs/session-generator.md` (what to practise today)
- `docs/architecture.md` (drill schema, grader contract, tolerances)

Hardware constraints live in `CLAUDE.md` and are verified facts, not assumptions.

## Running it

Requires Node 20.19+ or 22.12+. This machine's default `node` on PATH is an EOL
21.x, which Vite 8 crashes on, so the version is pinned in `.nvmrc`:

```bash
nvm use && npm run dev
```

`npm run dev` fails fast with instructions if the Node version is wrong.

Chromium only. Web MIDI does not exist in Safari and there is no fallback by
design. The browser asks for MIDI permission on first load of the inspector.

## Routes

| Route         | What it is                                               |
| ------------- | -------------------------------------------------------- |
| `#/`          | Shell.                                                   |
| `#/train`     | The drills you actually practise on. Scheduled or free.  |
| `#/hud`       | Free play. Names what you play, times the changes.       |
| `#/progress`  | Sessions per week, the tree, backups.                    |
| `#/grader`    | Grader bench: one chord prompt, graded live.             |
| `#/audio`     | Sampled piano, dry/sustained switch, the clock offset.   |
| `#/inspector` | Live MIDI monitor. Permanent debug route, never removed. |

The inspector is the ground truth whenever a grader misbehaves. It shows the raw
status bytes beside the normalized event, so a disagreement between what the
instrument sent and what the app decoded is always visible. Its counters panel
continuously re-checks the three hardware facts everything else depends on:
velocity is always 100, every note arrives on channel 1, and the driver supplies
real timestamps.

## The drills

`#/train` runs all of them. Press space, answer, and a correct answer draws the
next prompt by itself; a miss reveals the answer, offers to play it, and waits
for space. Five exist:

| Drill                 | Node                | Items | Prompt            | Graded by                        |
| --------------------- | ------------------- | ----- | ----------------- | -------------------------------- |
| Note find             | `kt-geography`      | 12    | a note name       | latency, any octave              |
| Inversion trainer     | `kt-triads-*`       | 72    | a chord symbol    | latency, bass note must match    |
| Pulse sync            | `pr-pulse-sync`     | 4     | a key and a tempo | where the notes landed           |
| Finger legato         | `pr-legato-5finger` | 12    | a five-finger key | when each note was released      |
| Interval ear training | `ear-intervals-1`   | 6     | two notes, played | latency from the end of playback |

Three of them seed a track. The keyboard-theory track is gated behind note find,
which is why nothing else in it opens until that deck is 80% mastered; the tree
calls it a calibration node and expects it to clear in a session or two. Pulse
sync is the baseline every timing window in the app is calibrated against
(`architecture.md` §9.2). Interval ear training starts week one by design and has
no dependencies at all.

**Pulse sync** is the only drill with no latency. Four clicks count you in, then
eight beats, and the pass is every note matched with mean error and spread under
the tree's maxima. A near miss (all eight notes, timing slightly over) is rated
`hard` rather than `again`, because `session-generator.md` §2 says so and because
counting a lapse for a 38ms average would put the item eight reps from being
suspended as a leech.

**Interval ear training** plays two notes and asks for the second one. The
starting note is drawn per rep, the answer is an exact pitch rather than a pitch
class (an octave-equivalent P8 would be answered by the note you were just
given), and the clock starts at the end of playback so listening time is never
charged to you.

**Finger legato** is the last of the three drills `CLAUDE.md` names, and the only
one that measures a note-off. Nine notes up and back down a five-finger position,
and what is graded is `off(n) - on(n+1)` per join: the previous key has to come up
between 10 and 60ms _after_ the next one goes down. Twelve items is two hands by
six keys, because the tree marks the node `perHand` and the bar has to be cleared
with each hand separately.

Three things about it are not obvious:

- **It plays dry, whether you asked for it or not.** `pr-legato-5finger` is the
  one V1 node the tree marks `sustainSensitive`, and the instrument's sustain is
  permanently on and transmits nothing, so every legato failure sounds perfect
  through the keyboard's own speakers. `architecture.md` §6 makes dry playback a
  requirement rather than a preference, so presenting the drill forces the app
  piano into dry mode. The rule is read off the tree, not off a drill id, so the
  other ten `sustainSensitive` nodes get it free.
- **The hands sit two octaves apart.** Hands are told apart by pitch alone and
  §3.1 rejects any spec that crosses the split at authoring time. One octave
  apart fails that: a left hand at G3 reaches C4, which _is_ the split, and half
  the pattern would be graded as the right hand. Left hand in octave 2, right
  hand in octave 4.
- **A note that is never released is held over by definition.** A join needs
  `off(n)`, and a note still down when the rep ends has only a lower bound.
  Dropping it would flatter precisely the failure the drill exists to catch.

The tree's own notes describe a three-stage ladder (60 BPM quarters at a `[0, 80]`
band, then 72 quarters at `[10, 60]`, then 72 eighths). That ladder is climbed by
**moving the band**, not by adding items: the tree declares twelve items and the
declared count is the denominator mastery is measured against, so stages as
params would make 36 items in a node that could never read 100%. The band is a
setting for exactly the reason `architecture.md` §9.1 gives, and the trainer has a
panel for it, described under the grader bench below.

Two ways in:

- **Today's session** is the scheduler. The active set picks the nodes, spaced
  repetition picks the items, and softmax picks the order. A small tag under the
  prompt says why the item is there (due, still learning, new), because a
  scheduler that cannot answer "why this?" stops being trusted.
- **Free practice** is a deck chosen by hand in a shuffled cycle, so every item
  comes up once before any comes up twice. Right for hammering one deck, wrong
  for a due pool, which is why both exist.

Reps persist either way and both feed the same SRS. A deliberately drilled item
is a real rep however it was chosen. The exception is the HUD, below.

## The chord HUD

`#/hud` is the second of the three V1 drills and the one that is not a drill. It
has no items, no prompts and no grader, so there is nothing for the drill schema
to hold; what it has is a mode. You play a chart the way you already do, and the
app names the chord under your hands and times how long the hand took to get
there. Nothing on that screen can be got wrong.

`session-generator.md` §8 says why it exists: "his existing habit becomes the
scheduler's reconnaissance, the app earns value from him **before** demanding
anything". So it does write something, and it says on screen exactly what:

- **It names with `Chord.detect` and attributes with `buildExpected`.** The names
  are tonal's ranked candidates, which are heuristic and occasionally surprising
  (E-G-C reads as `Em#5` before it reads as `CM/E`). Which _item_ a chord counts
  as is decided by the same expected-pitch calculation the grader uses, matched
  on pitch classes plus the bass, so a chart voicing with a doubled root is the
  same item as the three-note reference. §2's rule that detection never grades is
  kept by having the two never touch.
- **A slow chord nudges `latEMA`, and only that.** No rep row, no rating, no due
  date, nothing against the daily faucet. Alpha 0.1, per §2.
- **The nudge only ever goes up.** Free play is unprompted, so a fast chord is
  not evidence: nobody was being timed. §8's own sentence is "chords whose change
  latency is consistently _slow_ get their items' `latEMA` nudged", and one-way is
  the only reading under which the HUD cannot be used to flatter an item without
  answering a prompt.
- **"Consistently" is three sightings, and the median of them.** One slow change
  is a hand that was somewhere else.

What it buys: a chord you are slow on in free play starts its first graded rep
with a slow prior instead of from nothing, so it takes more evidence before the
deck calls it automatic.

## The scheduler

`src/store/` is persistence and `src/schedule/` is the arithmetic, which is
entirely pure: every input including `now` and the random source is an argument,
so the scheduler is tested with a `Map`, a fixed clock and a seeded RNG.

What is built: the SM-2 update of `session-generator.md` §2 driven by the
latency band, the pass rules of §2 for timed drills, the item selection of §4,
the active set and WIP limits of §3, the new-item faucet with §9's governor
pause, and all of §7's skip handling (backlog compression, the gentle day back,
two-session re-entry).

Four of `architecture.md` §7's ten threshold shapes are measurable, because four
are all the three built graders can produce: `deckFluency`, `timedRun`, `earDeck`
and `legato`. The list lives in `MEASURABLE_THRESHOLDS` and has to move with the
grader registry, or a node reads 0% where it means "not built yet". The other six
say so on screen, and the test that used to assert `pr-legato-5finger` was one of
them was inverted rather than deleted when slice 7 built its grader.

What is deliberately not, and why:

- **The combination engine (§5).** `CLAUDE.md` puts it outside V1: it needs
  mastery history that does not exist yet.
- **Track-balanced block assembly (§6).** `nextTrack` maximises the gap between
  a track's target and actual share. One track has drills.
- **Fusion prediction and tempo governing.** Both are functions of fused
  exercises and tempo targets, and neither exists.

### Sessions per week

`CLAUDE.md` calls this the only metric that matters in weeks 1 and 2, so it is
the first and largest thing on `#/progress`, and it was built before the
scheduler was. `architecture.md` §9.6 attaches a decision to it: five or more
means the design is holding, three or fewer means shrink the default session
rather than tune any threshold.

Three decisions inside it (`src/store/weeks.ts`):

- **A session counts when it has a graded rep**, not when it reaches five
  minutes, and the row is written when a session _starts_. A session that ended
  with the tab being closed still happened, and a metric that drops those
  flatters a bad week, which is the one thing it must never do.
- **Days are shown next to sessions.** Five sessions in one Sunday is not what
  §9.6 means, and only reporting the headline would let a binge read as a habit.
- **Weeks are ISO and local.** An 11pm Sunday session is a Sunday session.

### Where the design documents needed reconciling

Slice 4 recorded two (under "Drills are data"). Slice 5 added the four below,
slice 6 the five after them and slice 7 the five after those, each pinned by a
test.

- **What a lapsed item graduates to.** §2 says a lapse sets
  `interval = max(1, interval * 0.3)` and, two lines later, that learning items
  "graduate at interval 1d (2d if easy)". Read literally the first line is dead
  and a card that had reached 40 days restarts as if it were new. Graduating at
  `max(1, intervalDays)` honours both: a genuinely new item has interval 0 and
  graduates at exactly 1d, while a lapsed one keeps its reduced interval.
- **`latEMA` on a wrong answer.** §2 says both EMAs update "on every rep", but
  `latEMA` feeds `itemMastered` as a measure of how fast an item is _known_, and
  a confident wrong answer is fast. `accEMA` updates on every rep; `latEMA` only
  on correct ones. This is the decision `summarise()` already makes for
  `automaticShare`, which the tree uses to call a deck complete.
- **What "next session" means as a timestamp.** The learning steps are
  "[in-session re-queue, next session]" and nothing knows when the next session
  is. Both steps are due immediately and §4's variety guard (at most twice per
  session) is what pushes the second out to tomorrow. The two rules were already
  describing one mechanism: §4 names the learning-step re-queue as the second of
  the two appearances.
- **A dep nothing can practise does not gate.** §1.3's unlock rule assumes every
  node has a drill. Three of the four V1 keyboard-theory nodes sit behind
  `kt-geography`, whose drill was slice 6, so the literal rule left the day-one
  queue empty with 72 practisable triads locked behind it. That is exactly the
  failure the tree's own `v1Patch` was written to fix, arriving again for a
  different reason. Undrillable deps are bypassed and **named on screen**; the
  bypass disappears by itself as the missing drills land. A dep that is
  drillable and merely unmastered still gates, as written. **Slice 6 expired
  this one**: note find gives `kt-geography` items, so it gates like any other
  dep and the test that asserted the bypass was inverted rather than deleted.

Slice 6, from the two threshold shapes and the one grader family it added:

- **What varies between two reps is not always part of the item.** The tree
  declares six items for `ear-intervals-1`, one per interval, and
  `architecture.md` §9.5 asks whether ear accuracy is worse in Db than in C,
  which is unanswerable if every rep starts on the same note. Six items and
  twelve starting notes cannot both be params, because the cartesian product is
  the pool. So a template may declare params that are absent from its
  `paramSpace` and fill them in per rep (`prepare`). A key in the space is part
  of the item's identity forever; a key `prepare` fills is part of one rep. Note
  find uses the same mechanism to ask for the same black key as C# or as Db.
- **`timedRun`'s `noteAccuracy: 1.0` is a per-rep rule, not an accuracy EMA.**
  §7 defines a timed pass as "all notes matched, stats under maxima", which the
  grader has already applied by the time the scheduler sees a rep. Read instead
  as an `accEMA` threshold, mastery would be unreachable: an EMA that has seen
  one miss never returns to 1, so a single early mistake would lock the node out
  of completion permanently. The item's bar is `cleanPasses` consecutive clean
  passes, which is §1.2's "last N reps all correct" with N from the tree.
- **`earDeck` is judged over a rolling window, so mastery is not purely a
  function of item state.** §7 says "answer matches; rolling window", and a
  window of the last 40 reps is not derivable from 6 item states. `nodeProgress`
  takes the rep log for exactly this one threshold shape. Its latency target is
  its own `medianResponseMsMax` of 2500ms rather than the 1200ms automatic band,
  because the answer follows a sound the user had to listen to first.
- **A timed rep is bounded by its grid, not by the prompt being painted.** The
  untimed grader discards everything before `promptReadyAt`, which is right when
  the prompt appearing is what starts the rep. A timed rep is counted in first
  and its grid is known before the prompt is armed, so filtering by the paint as
  well makes the first beat depend on when the browser got round to compositing.
  This one was found by playing it: a slow frame put `promptReadyAt` 484ms after
  beat 0 and the grader reported a note that had been played as missing.
- **The ear deck answers on the keyboard, for now.** §9.5 says to switch the
  deck to `answerMode: 'choice'` if accuracy correlates with key familiarity,
  because that would mean keyboard fluency is contaminating the ear signal. That
  is a response to a measurement that does not exist yet, and this drill is what
  produces it; the tree's own node says "answer by playing the second note from a
  given first note", and §9.5 credits the keyboard training before it warns. The
  trigger to flip: if ear accuracy tracks which key the interval started in
  rather than which interval it was, the raw log will show it, and the change is
  this template plus a non-MIDI answer path in the runner.

Slice 7, from the legato grader and the HUD:

- **A threshold number the user recalibrates cannot live in the curriculum.** §7
  puts `overlapBandMs` on the node's threshold next to `inBandShare`, which reads
  as "the drill hands both to the grader", the shape `timedRun` already has. But
  §9.1 puts that band first on the list of numbers that will be wrong and
  prescribes moving it toward his own p25/p75 over sessions, and `skill-tree.json`
  is the curriculum rather than a scratchpad. So the two halves travel
  differently: the share is on the drill, the band is a **setting** merged into
  the tolerances when a prompt is armed, and the tree's value is where that
  setting starts. A test pins the default to the tree, so the split cannot drift
  into a disagreement.
- **One drill's constants are not the engine's.** `present.ts` started the
  metronome for `PULSE_BEATS` beats, which was correct for exactly as long as
  there was one timed drill. The legato line is nine notes over four beats and
  would have been counted against a click running twice as long as the pattern.
  A drill's grid comes from its own expected events, and this is the breach of
  "drills are data" that slice 7 was warned to look for and found.
- **"Never scheduling" needs a definition of "in the SRS".** §8 says harvested
  reps update `latEMA` only and never schedule. `latEMA` lives on an `ItemState`,
  and until now the existence of a state row _was_ what the selector read as "this
  item has been practised", since nothing else ever created one. A harvested row would
  therefore arrive in the due pool the instant a chord was overheard, having never
  been counted against the daily faucet. `reps > 0` is the test, and always was;
  it just never had to be said out loud.
- **The harvest can only make an item look slower.** §2 gives it an alpha and
  nothing else, and read symmetrically that is a hole rather than a measurement:
  free play is unprompted, so a chord that happens to fall under the hand twice
  reports a latency nobody was being timed on. §8's own wording settles it:
  "chords whose change latency is consistently **slow**", so the nudge is
  one-way, and an item with no latency yet is treated as sitting at the automatic
  threshold rather than being seeded from below it.
- **§8's change latency needs a grid the app does not have.** It is defined as the
  "gap between successive chart chords vs. the chart's grid", and there is no
  chart: the app is watching, not accompanying. What is observable is the moment
  the previous chord stopped being intact, which is its first release, and the moment
  this one was complete. That span is a **floor** on the hunting rather than the
  whole of it, since a player who holds the old chord while working out the next
  one is thinking on the app's blind side. Which is the argument for §8's own
  alpha of 0.1 rather than against the measurement.

### Storage

Five localForage instances over one IndexedDB database, matching
`architecture.md` §8. There are no cross-store transactions, which matters
exactly once: a rep and the item state it caused are two writes. The rep goes
first, so a crash between them loses a derived value rather than a fact, and
**Rebuild from log** replays `repLog` to recover it, since the SM-2 update is
deterministic given the rating sequence.

Raw MIDI is buffered and flushed every ten reps rather than written per rep. It
exists so tolerance changes can re-grade recent history, so losing the tail of
one session to a crashed tab costs a re-grade, not a fact.

Two numbers in `settings` are calibration rather than preference: the latency
bands and the legato band. Both are the numbers `architecture.md` §9 predicts will
be wrong, and both are settings for the reason §10 gives in as many words: "keep
them settings, not constants". The legato band has a panel on `#/train` that
appears once a session has produced overlaps, showing the distribution beside the
control, because §9.1's instruction is to set the edges from that distribution and
the control belongs next to the evidence. Moving it changes how the next rep is
graded and not how the last one was; `noteOverlapMs` is kept raw, so an old rep can
be re-read against a new band.

`navigator.storage.persist()` is requested on first run and the answer is
reported on `#/progress`. Export a backup now and then: there is no server and
no sync, so a file in Downloads is the entire recovery plan.

## Drills are data

A drill is a `DrillTemplate` object in `src/drills/`. The cartesian product of
its `paramSpace` is its item pool, and `itemId = stableHash(templateId + params)`
so an id survives reloads and refactors: it is the primary key the store slice
will key spaced repetition on. Adding a drill is adding a template to the
registry. The trainer contains no chord knowledge at all.

Two more decisions in there are not directly in the design documents, both
forced by the documents disagreeing with each other:

- **An item belongs to more than one node.** `architecture.md` §2 derives an item
  id from `(templateId, params)` while `session-generator.md` §1.1 derives it
  from `(nodeId, params)`. The tree settles it: `kt-triads-root` declares 24
  items and `kt-inv-maj-triads` 36, over 72 distinct triads, so root-position
  triads are claimed by both nodes. An item is one physical task, and node
  membership is a many-to-many relation derived from its params. `pool.test.ts`
  checks the three counts against `docs/skill-tree.json` rather than against
  literals, so a disagreement surfaces as a failing test.
- **The root param is a pitch class, not a note name.** Root names depend on
  quality (Gb major, but F# minor, because Gb minor spells its third Bbb), so a
  space of names would need a filter and the product would stop being the pool.
  Spelling is a prompt concern.

Slice 6 added a third: **a drill may need per-rep values that are not part of the
item**, which is `prepare` above. And it tested the claim. Four drills of three
different shapes now run through one screen that knows the id of none of them:
what it shows comes from the template's `view`, and how it reports a result comes
from the shape of the `GradeResult`. Registering a template was the whole of
adding a drill; the engine was not touched for any of the three.

Slice 7 was the first one to find the claim actually broken, which is what the
claim is for. Adding the legato drill needed no edit to the trainer, since it reports
an in-band share instead of a latency because the result has overlaps on it, not
because the screen knows what a legato drill is, but the metronome turned out to
be laid out from `PULSE_BEATS`, a constant belonging to the pulse drill. Nine
eighth notes and eight quarter notes are different lengths of click. The fix was
the schema's, not the drill's: a timed prompt's grid is derived from its own
expected events, and the count-in moved to `audio/transport.ts`, which is what
owns the idea of counting a drill in.

## The grader bench

`#/grader` is one rep at a time with every grader decision laid out beside it. It
draws from the trainer's own item pool, so a chord that grades oddly there is the
same item, with the same id, here. Two tolerances decide what counts as one
answer, and both are the numbers `architecture.md` §9 expects to be wrong first:

- **chord window, 80ms** — note-ons this close together are one chord. Editable on
  the bench. A chord placed more slowly than this is graded in pieces, and the
  cluster panel shows exactly that when it happens.
- **settle, 300ms** — silence this long after a chord means the answer is in. The
  first settled chord is the answer, so a wrong chord, a pause, then the right one
  grades the wrong one.

The other two numbers §9 names live where they can be seen against something.
The **legato band** ([10, 60]ms of overlap) is on `#/train`, beside the
distribution of the session's own joins, because §9.1's fix is to set the edges at
his p25/p75 and the button there does exactly that. The bench is untimed by
construction, so the third lives on the pulse drill instead: **the timing window**, `clamp(40, 0.25 x IOI, 120)` per
`architecture.md` §4. At 100 BPM a quarter note gives 150ms, over the ceiling, so
the window is 120ms and a note within it is on time, within 240ms is late or
early with the error recorded, and beyond that is missing. §9.2 expects that
formula to be wrong and says how to fix it: take the distribution of |timing
error| over passes you call good and set the window at its p90. The pulse drill
is what produces that distribution, and `rawMidi` is what lets old reps be
re-graded once it moves.

### The clock, and one thing Tone will not do

Beat 0 of a timed drill is one number, `gridStartMs`, converted once from the
Transport's start time through the calibrated offset. That is CLAUDE.md's clock
gotcha with a name: get it wrong and every timing score is off by a constant
that no screen would ever show. It is a field on the spec rather than a
conversion inside the grader precisely so a test can assert it, and the shape of
the failure is worth recognising by eye, since a wrong offset is a large `mean`
beside a tiny `sd`.

**Clicks are scheduled ahead, not dispatched by the Transport.** Tone's clock
hands a scheduled callback a time that has already passed when `lookAhead` is 0,
up to one update interval (50ms) late, and `lookAhead` is 0 for the whole app so
that echoing a key press is not delayed by a tenth of a second. That is
inaudible for a UI callback and ruinous for a metronome you are being graded
against. So the Transport owns musical time (tempo, position, the beat length
every click is derived from) and each click of a run is booked up front at its
absolute time on the audio clock, which is sample accurate. The cost is that
stopping a run has to cancel the click envelope as well as the Transport.

## Scripts

```bash
npm run dev        # dev server
npm run build      # typecheck then production build
npm run typecheck  # tsc only
npm run lint       # eslint
npm run format     # prettier (never touches docs/ or CLAUDE.md)
```

## Build progress

Vertical slices, each runnable before the next begins.

1. MIDI layer and inspector (done)
2. Audio out, sampled piano, clock offset (done)
3. Theory and grader contract, with unit tests (done)
4. Drill schema and inversion trainer (done)
5. Progress store and scheduler (done)
6. Seeding drills: note-find, rhythm-tap, ear-id (done)
7. Chord HUD and legato drill (done)

Slice 3 built the `set` grader, which covers every untimed drill. Slice 4 built
the schema, the 72-item pool and the trainer on top of it. Slice 5 made all of
it persist and put a scheduler in front of it.

Slice 6 built the three drills that seed the other two tracks, and the `sequence`
grader the first of them needed. Slice 7 built the last two V1 drills and the
`legato` grader, which is `sequence` plus one measurement. Three of
`architecture.md` §2's six grader families now exist; the remaining three
(`sync`, `piece`, `pedal`) are typed but unimplemented, and `graderFor()` throws
rather than scoring zero if a drill asks for one. They arrive with the drills that
need them, and none of those drills is in V1.

What that changes on a first run: the active set is now three nodes, one per
track (`kt-geography`, `pr-pulse-sync`, `ear-intervals-1`), which is the first
time the WIP limits of §3 have had more than one node to hold. The triads are
locked behind keyboard geography until it reaches 80%, as the tree always
intended, and the 8-item daily faucet is what paces the three decks opening at
once.

**V1 is complete.** `CLAUDE.md` names three drills and puts a hard stop after
them: ship them, then practise for two weeks before building anything else. The
inversion trainer landed in slice 4, the chord HUD and finger legato in slice 7,
and the three seeding drills in slice 6 exist because the tree's own unlock rule
left nothing to practise on day one without them.

So the next thing to build is nothing. What to watch instead, in order:

1. **Sessions per week** (`#/progress`). Five or more and the design is holding;
   three or fewer and the response is a shorter default session, not a tuned
   threshold. §9.6 is explicit that the tree can be wrong for months and recover
   and the habit cannot.
2. **The legato band.** The captured log shows ~60ms overlaps, which puts the
   starting hand at the smeared edge of [10, 60]. If stage 1 feels impossible,
   widen the band from the panel rather than arguing with the tree.
3. **The timing window.** The pulse drill now produces the distribution §9.2
   wants; the window moves to its p90 over passes that felt good.
4. **Whether ear accuracy tracks the key** rather than the interval. If it does,
   §9.5 says flip that deck to `answerMode: 'choice'`.

The four graders that would come next (`sync`, `piece`, `pedal`, and the one an
`articulation` threshold needs) all belong to nodes outside V1, and the fusion engine
still needs mastery history that two weeks of practice is what produces.
