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
| `#/train`     | The drill you actually practise on. Scheduled or free.   |
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

## The inversion trainer

`#/train` is V1 drill 1. Press space, play what the symbol says. A correct
answer shows its latency and draws the next prompt by itself; a miss reveals the
notes, offers to play them, and waits for space.

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
latency band, the item selection of §4, the active set and WIP limits of §3, the
new-item faucet with §9's governor pause, and all of §7's skip handling
(backlog compression, the gentle day back, two-session re-entry).

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

### Four places the design documents needed reconciling

Slice 4 recorded two (below). Slice 5 added four more, each pinned by a test.

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
  `kt-geography`, whose drill is slice 6, so the literal rule leaves the day-one
  queue empty with 72 practisable triads locked behind it. That is exactly the
  failure the tree's own `v1Patch` was written to fix, arriving again for a
  different reason. Undrillable deps are bypassed and **named on screen**; the
  bypass disappears by itself as the missing drills land. A dep that is
  drillable and merely unmastered still gates, as written.

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
6. Seeding drills: note-find, rhythm-tap, ear-id
7. Chord HUD and legato drill

Slice 3 built the `set` grader, which covers every untimed drill and so four of
the seven V1 nodes (`kt-geography`, `kt-triads-root`, `kt-inv-maj-triads`,
`kt-inv-min-triads`). The five other grader families in `architecture.md` §2 are
typed but unimplemented; `graderFor()` throws rather than scoring zero if a drill
asks for one. The timed families arrive with the drills that need them.

Slice 4 built the schema, the 72-item pool and the trainer on top of that
grader. Slice 5 made all of it persist and put a scheduler in front of it.

What slice 5 leaves for slice 6 is drills, not machinery. Only one node
(`kt-triads-root`, 24 items) is in play on a first run, because the inversion
trainer is the only registered drill and the tree gates the inversion nodes
behind it. `kt-geography`, `pr-pulse-sync` and `ear-intervals-1` are unlocked and
waiting with no way to practise them, which is what the note-find, rhythm-tap
and ear-id drills are for. The scheduler already handles them: the moment a
template is registered against those nodes, their items enter the pool, the
active set fills toward its cap of 2 per track and 5 total, and `kt-geography`
stops being bypassed and starts gating like any other dep.
