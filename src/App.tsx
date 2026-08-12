/**
 * App shell. Hash routing is hand-rolled: a router library would be a fifth
 * dependency for a single-user app with three routes.
 */

import { useEffect, useState } from 'react';
import Inspector from './Inspector.tsx';
import AudioScreen from './Audio.tsx';
import { audio, session, useAudioSession } from './audio/index.ts';

const ROUTES = [
  { path: '/', label: 'Home' },
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
      <h2>Slice 2: audio out and the clock offset</h2>
      <p>
        The <a href="#/audio">audio screen</a> starts the sampled piano and calibrates the
        offset between the MIDI clock and the audio clock. Turn the keyboard&apos;s own
        volume down: the app is the sound source now.
      </p>
      <p>
        MIDI event timestamps and <code>AudioContext.currentTime</code> have different
        origins, so they are bridged through <code>getOutputTimestamp()</code> once at
        startup rather than subtracted. That number is on screen next to a key-to-speaker
        latency derived from it, because a wrong offset is silent: it would put a constant
        error into every timing score in slice 3 and look fine.
      </p>
      <p>
        Playback has a <strong>dry</strong> and a <strong>sustained</strong> mode. The
        keyboard&apos;s sustain is permanently on, local to its own sound engine, and
        sends nothing over MIDI, so dry mode is the only way to hear note separation the
        way the legato grader measures it.
      </p>
      <p>
        The <a href="#/inspector">MIDI inspector</a> stays as the debug route: raw bytes,
        the three hardware assertions, and the control change breakdown.
      </p>
      <p className="muted">The grader and the three V1 drills land in later slices.</p>
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
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
