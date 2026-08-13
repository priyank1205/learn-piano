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
| `#/`          | Shell. Becomes the session runner in a later slice.      |
| `#/train`     | Inversion trainer. The drill you actually practise on.   |
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

`#/train` is V1 drill 1. Pick a deck, press space, play what the symbol says.
A correct answer shows its latency and draws the next prompt by itself; a miss
reveals the notes, offers to play them, and waits for space. Missed items come
back after three to six others in the same session, which is the in-session half
of the `again` learning step in `session-generator.md` §2.

Everything else in that document needs history that does not exist yet. There is
no spaced repetition, no due date, no mastery and no persistence: reps last until
the page reloads. Order inside a session is a shuffled cycle, so every item in
the deck comes up once before any comes up twice.

## Drills are data

A drill is a `DrillTemplate` object in `src/drills/`. The cartesian product of
its `paramSpace` is its item pool, and `itemId = stableHash(templateId + params)`
so an id survives reloads and refactors: it is the primary key the store slice
will key spaced repetition on. Adding a drill is adding a template to the
registry. The trainer contains no chord knowledge at all.

Two decisions in there are not directly in the design documents, both forced by
the documents disagreeing with each other:

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
5. Progress store and scheduler
6. Seeding drills: note-find, rhythm-tap, ear-id
7. Chord HUD and legato drill

Slice 3 built the `set` grader, which covers every untimed drill and so four of
the seven V1 nodes (`kt-geography`, `kt-triads-root`, `kt-inv-maj-triads`,
`kt-inv-min-triads`). The five other grader families in `architecture.md` §2 are
typed but unimplemented; `graderFor()` throws rather than scoring zero if a drill
asks for one. The timed families arrive with the drills that need them.

Slice 4 built the schema, the 72-item pool and the trainer on top of that
grader. What it deliberately left out is everything that needs to outlive a page
load, which is the whole of slice 5: `ItemState`, the rep log, the raw-MIDI ring
buffer, and the count of **sessions per week**, which `CLAUDE.md` calls the only
metric that matters in weeks 1 and 2 and which cannot be counted until something
persists. `practice.summary()` already returns the `sessionLog` row shape from
`architecture.md` §8, so the store writes it rather than inventing it.
