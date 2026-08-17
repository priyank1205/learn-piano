/**
 * The scheduler's public surface (session-generator.md).
 *
 * Everything in here is pure. The store owns the data and the clock; this owns
 * the arithmetic that turns one into a decision about what to play next, and it
 * can be tested with a Map, a fixed `now` and a seeded random source.
 *
 * What is deliberately absent, and why:
 *
 *  - **The combination engine (section 5).** CLAUDE.md puts the fusion engine
 *    outside V1 explicitly: it needs mastery history that does not exist yet.
 *  - **Track-balanced block assembly (section 6).** `nextTrack` maximises the
 *    gap between a track's target and actual share, which needs at least two
 *    tracks to have drills. One does.
 *  - **Fusion difficulty prediction and tempo governing (sections 5.2, 9).**
 *    Both are functions of fused exercises and tempo targets, and neither
 *    exists. The parts of section 9 that do apply now — the faucet pause and
 *    leech suspension — are in `select.ts` and `srs.ts`.
 */

export * from './srs.ts';
export * from './mastery.ts';
export * from './select.ts';
