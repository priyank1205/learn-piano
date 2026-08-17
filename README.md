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
for space. Four exist:

| Drill                 | Node              | Items | Prompt            | Graded by                        |
| --------------------- | ----------------- | ----- | ----------------- | -------------------------------- |
| Note find             | `kt-geography`    | 12    | a note name       | latency, any octave              |
| Inversion trainer     | `kt-triads-*`     | 72    | a chord symbol    | latency, bass note must match    |
| Pulse sync            | `pr-pulse-sync`   | 4     | a key and a tempo | where the notes landed           |
| Interval ear training | `ear-intervals-1` | 6     | two notes, played | latency from the end of playback |

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

Two ways in:

- **Today's session** is the scheduler. The active set picks the nodes, spaced
  repetition picks the items, and softmax picks the order. A small tag under the
  prompt says why the item is there (due, still learning, new), because a
  scheduler that cannot answer "why this?" stops being trusted.
- **Free practice** is a deck chosen by hand in a shuffled cycle, so every item
  comes up once before any comes up twice. Right for hammering one deck, wrong
  for a due pool, which is why both exist.

Reps persist either way and both feed the same SRS. A deliberately drilled item
is a real rep however it was chosen. (The exception in the spec is `§8`'s
free-play HUD harvest, which is passive telemetry, updates `latEMA` only, and
does not exist yet.)

## The scheduler

`src/store/` is persistence and `src/schedule/` is the arithmetic, which is
entirely pure: every input including `now` and the random source is an argument,
so the scheduler is tested with a `Map`, a fixed clock and a seeded RNG.

What is built: the SM-2 update of `session-generator.md` §2 driven by the
latency band, the pass rules of §2 for timed drills, the item selection of §4,
the active set and WIP limits of §3, the new-item faucet with §9's governor
pause, and all of §7's skip handling (backlog compression, the gentle day back,
two-session re-entry).

Three of `architecture.md` §7's ten threshold shapes are measurable, because
three are all the two built graders can produce: `deckFluency`, `timedRun` and
`earDeck`. The list lives in `MEASURABLE_THRESHOLDS` and has to move with the
grader registry, or a node reads 0% where it means "not built yet". The other
seven say so on screen.

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

Slice 4 recorded two (under "Drills are data"). Slice 5 added the four below and
slice 6 the five after them, each pinned by a test.

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

The bench is untimed by construction, so the third number lives on the pulse
drill instead: **the timing window**, `clamp(40, 0.25 x IOI, 120)` per
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
7. Chord HUD and legato drill

Slice 3 built the `set` grader, which covers every untimed drill. Slice 4 built
the schema, the 72-item pool and the trainer on top of it. Slice 5 made all of
it persist and put a scheduler in front of it.

Slice 6 built the three drills that seed the other two tracks, and the `sequence`
grader the first of them needed. Two of `architecture.md` §2's six grader
families now exist; the remaining four are typed but unimplemented, and
`graderFor()` throws rather than scoring zero if a drill asks for one. They
arrive with the drills that need them, which is slice 7 for `legato`.

What that changes on a first run: the active set is now three nodes, one per
track (`kt-geography`, `pr-pulse-sync`, `ear-intervals-1`), which is the first
time the WIP limits of §3 have had more than one node to hold. The triads are
locked behind keyboard geography until it reaches 80%, as the tree always
intended, and the 8-item daily faucet is what paces the three decks opening at
once.

Slice 7 is the chord HUD and the finger legato drill, which is the last of the
three V1 drills CLAUDE.md names. It needs the `legato` grader (note overlap per
transition, `off(n) - on(n+1)`, against the [10, 60]ms band), the `legato`
threshold type added to `MEASURABLE_THRESHOLDS` beside the other three, and dry
playback routed through the app piano, because `pr-legato-5finger` is the one V1
node marked `sustainSensitive` and the instrument's own sustain hides exactly
what that drill measures.
