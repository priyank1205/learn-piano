/**
 * App shell. Hash routing is hand-rolled: a router library would be a fifth
 * dependency for a single-user app with three routes.
 */

import { useEffect, useState } from 'react';
import Inspector from './Inspector.tsx';

const ROUTES = [
  { path: '/', label: 'Home' },
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

function Home() {
  return (
    <div className="home">
      <h2>Slice 1: MIDI layer and inspector</h2>
      <p>
        The MIDI ingest layer normalizes every message to{' '}
        <code>{'{ type, pitch, ts, velocity, channel }'}</code> and decodes status bytes
        directly, so note-offs are read from <code>0x80</code> rather than inferred.
      </p>
      <p>
        Open the <a href="#/inspector">MIDI inspector</a> and play a few notes. The
        counters panel checks the three hardware facts the rest of the app is built on:
        velocity is always 100, everything is on channel 1, and the driver supplies real
        timestamps.
      </p>
      <p className="muted">
        Audio out, the grader, and the drills land in later slices. This route stays a
        stub until there is a session to run.
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
      </header>
      <main>{route === '/inspector' ? <Inspector /> : <Home />}</main>
    </div>
  );
}
