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
import { audio, session, useAudioSession } from './audio/index.ts';
import { store } from './store/index.ts';

const ROUTES = [
  { path: '/', label: 'Home' },
  { path: '/train', label: 'Train' },
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
      <h2>Slice 6: the seeding drills</h2>
      <p>
        All three tracks have something to practise now. <strong>Note find</strong> is the
        keyboard-geography deck the whole theory track sits behind,{' '}
        <strong>pulse sync</strong> is quarter notes against the Transport click, and{' '}
        <strong>interval ear training</strong> plays two notes and asks for the second
        one. With the triads that makes four drills, and <a href="#/train">a session</a>{' '}
        now moves between them.
      </p>
      <p>
        Today&apos;s session is the scheduler doing the choosing. Correctness gates and
        latency grades, so an answer under 1.2 seconds pushes the item further out than a
        correct answer at four seconds does. The pulse drill is the exception and is
        judged on where the notes landed instead. Order is softmax-sampled rather than
        sorted, missed items come back after three to six others, and a gap of a few days
        makes the next session smaller instead of presenting a wall. Free practice is
        still there for hammering one deck by hand.
      </p>
      <p>
        <a href="#/progress">Progress</a> counts <strong>sessions per week</strong>, which
        is the only number that matters for the next fortnight: five or more says the
        design is holding, three or fewer says make the sessions shorter rather than tune
        anything.
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
        ) : route === '/progress' ? (
          <ProgressScreen />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
