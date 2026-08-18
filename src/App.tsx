/**
 * App shell. Hash routing is hand-rolled: a router library would be a fifth
 * dependency for a single-user app with three routes.
 */

import { useEffect, useState } from 'react';
import Inspector from './Inspector.tsx';
import AudioScreen from './Audio.tsx';
import GraderScreen from './Grader.tsx';
import TrainerScreen from './Trainer.tsx';
import ProgressScreen from './Progress.tsx';
import HudScreen from './Hud.tsx';
import { audio, session, useAudioSession } from './audio/index.ts';
import { store } from './store/index.ts';

const ROUTES = [
  { path: '/', label: 'Home' },
  { path: '/train', label: 'Train' },
  { path: '/hud', label: 'Chord HUD' },
  { path: '/progress', label: 'Progress' },
  { path: '/grader', label: 'Grader bench' },
  { path: '/audio', label: 'Audio out' },
  { path: '/inspector', label: 'MIDI inspector' },
] as const;

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

/**
 * Audio control in the header rather than only on its own route, so the piano
 * can be heard while watching the inspector. Debugging a grader by ear and by
 * event log at the same time is the whole reason the inspector is permanent.
 */
function AudioControl() {
  const s = useAudioSession();

  if (s.status === 'ready') {
    return (
      <span className="audio-control">
        <span className="dot on" />
        <button
          onClick={() => session.setMode(audio.mode === 'dry' ? 'sustained' : 'dry')}
          title="Dry damps each note on its note-off. Sustained lets notes ring out."
        >
          {audio.mode}
        </button>
      </span>
    );
  }

  return (
    <span className="audio-control">
      <span className={s.status === 'error' ? 'dot' : 'dot off'} />
      <button onClick={() => void session.start()} disabled={s.status === 'starting'}>
        {s.status === 'starting' ? 'starting...' : 'start audio'}
      </button>
    </span>
  );
}

function Home() {
  return (
    <div className="home">
      <h2>V1 is built</h2>
      <p>
        <code>CLAUDE.md</code> names three drills and puts a hard stop after them. All
        three exist: the <strong>inversion trainer</strong>, the{' '}
        <strong>chord HUD</strong>, and <strong>finger legato</strong>, plus the three
        seeding drills the tree needed before any of them could be reached. Seven decks
        across three tracks now run through <a href="#/train">one screen</a> that knows
        the id of none of them.
      </p>
      <p>
        <strong>Finger legato</strong> is the one that measures a note-off. It grades the
        gap between letting one key up and putting the next one down, which is the thing
        the instrument&apos;s permanent sustain has been hiding: the same playing sounds
        identical through the keyboard and is plainly detached in the MIDI stream. It
        plays through the app&apos;s dry piano for exactly that reason, and the target
        band is adjustable, because it was calibrated off a single captured log and is the
        first number expected to be wrong.
      </p>
      <p>
        The <a href="#/hud">chord HUD</a> is the one that asks for nothing. No prompts and
        nothing graded: play a chart the way you already do, and it names what you played
        and times how long the hand took to get there. Chords it finds you consistently
        slow on start their first real rep with a slower assumption. That is the whole of
        what it does with it.
      </p>
      <p>
        So the next thing to build is nothing. <a href="#/progress">Progress</a> counts{' '}
        <strong>sessions per week</strong>, which is the only number that matters for the
        next fortnight: five or more says the design is holding, three or fewer says make
        the sessions shorter rather than tune anything.
      </p>
      <p>
        The <a href="#/grader">grader bench</a> is the place to watch one rep being
        decided, with the chord window and the settle window exposed. The{' '}
        <a href="#/audio">audio screen</a> owns the piano and the clock offset, and the{' '}
        <a href="#/inspector">MIDI inspector</a> is still the ground truth when a grade
        looks wrong.
      </p>
      <p className="muted">
        There is no server and no sync. Export a backup from the progress screen now and
        then: a file in Downloads is the whole recovery plan.
      </p>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();

  // Opened once for the whole app rather than per screen, so the first render
  // of any route already knows whether there is history.
  useEffect(() => {
    void store.load();
  }, []);

  return (
    <div className="app">
      <header>
        <h1>learn-piano</h1>
        <nav>
          {ROUTES.map((r) => (
            <a
              key={r.path}
              href={`#${r.path}`}
              className={route === r.path ? 'active' : undefined}
            >
              {r.label}
            </a>
          ))}
        </nav>
        <AudioControl />
      </header>
      <main>
        {route === '/inspector' ? (
          <Inspector />
        ) : route === '/audio' ? (
          <AudioScreen />
        ) : route === '/grader' ? (
          <GraderScreen />
        ) : route === '/train' ? (
          <TrainerScreen />
        ) : route === '/hud' ? (
          <HudScreen />
        ) : route === '/progress' ? (
          <ProgressScreen />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
