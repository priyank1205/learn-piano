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
| `#/inspector` | Live MIDI monitor. Permanent debug route, never removed. |

The inspector is the ground truth whenever a grader misbehaves. It shows the raw
status bytes beside the normalized event, so a disagreement between what the
instrument sent and what the app decoded is always visible. Its counters panel
continuously re-checks the three hardware facts everything else depends on:
velocity is always 100, every note arrives on channel 1, and the driver supplies
real timestamps.

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
2. Audio out, sampled piano, clock offset
3. Theory and grader contract, with unit tests
4. Drill schema and inversion trainer
5. Progress store and scheduler
6. Seeding drills: note-find, rhythm-tap, ear-id
7. Chord HUD and legato drill
