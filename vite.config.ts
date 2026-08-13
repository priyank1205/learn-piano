/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Honour a port handed over by the environment. Vite's own fallback picks
    // its next free port silently, which leaves a second dev server running
    // somewhere nobody is looking for it.
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    // The grader and the decoder are pure functions over arrays of events, so
    // they need no DOM. Anything needing one can opt in per file.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
