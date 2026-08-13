/**
 * App shell. Hash routing is hand-rolled: a router library would be a fifth
 * dependency for a single-user app with three routes.
 */

import { useEffect, useState } from 'react';
import Inspector from './Inspector.tsx';
import AudioScreen from './Audio.tsx';
import GraderScreen from './Grader.tsx';
import TrainerScreen from './Trainer.tsx';
import { audio, session, useAudioSession } from './audio/index.ts';

const ROUTES = [
  { path: '/', label: 'Home' },
  { path: '/train', label: 'Inversion trainer' },
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
      <h2>Slice 4: the drill schema and the inversion trainer</h2>
      <p>
        The <a href="#/train">inversion trainer</a> is the first screen here that is for
        practising rather than for proving something works. Pick a deck, press space, and
        it prompts triads by symbol until you stop: a correct answer advances by itself, a
        miss shows the notes and comes back later in the same session. Latency is the
        score. Correctness only decides whether the latency counts.
      </p>
      <p>
        Drills are data. The trainer contains no chords: it renders whatever the{' '}
        <code>DrillTemplate</code> hands it, and the 72 items are the cartesian product of
        that template&apos;s param space, each with a stable hashed id so the store slice
        can key spaced repetition on it. A second drill is a second template, not an edit
        to this screen.
      </p>
      <p>
        The <a href="#/grader">grader bench</a> is still the place to watch one rep being
        decided, with the chord window and the settle window exposed. It now builds its
        prompts from the same template the trainer runs, so the two cannot disagree about
        what a chord is.
      </p>
      <p>
        The <a href="#/audio">audio screen</a> owns the piano and the clock offset, and
        the <a href="#/inspector">MIDI inspector</a> is still the ground truth when a
        grade looks wrong.
      </p>
      <p className="muted">
        Nothing is saved yet. Spaced repetition, mastery and sessions per week arrive with
        the store slice.
      </p>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();

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
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
