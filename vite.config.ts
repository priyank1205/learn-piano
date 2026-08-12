/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // The grader and the decoder are pure functions over arrays of events, so
    // they need no DOM. Anything needing one can opt in per file.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
