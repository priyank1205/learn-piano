/**
 * Delivering a prompt: the step between "this item is next" and "the clock is
 * running".
 *
 * Until slice 6 that step was nothing. A chord symbol is on screen the moment it
 * renders, so the practice loop could arm the runner and be done. Two of the
 * three seeding drills are not like that. An ear prompt has to be **played**,
 * and the clock cannot start until it stops (architecture.md section 5,
 * `promptReadyAt`). A pulse drill has to be counted in, and the grid it will be
 * graded against has to exist before the first note is played.
 *
 * All of that lives here rather than in `practice.ts`, which decides what comes
 * next, or in the templates, which are data and own no audio. What the loop asks
 * for is a prepared item; what this module does to produce one is a detail of
 * how the prompt is delivered, and every future drill that plays, counts in or
 * waits gets the same treatment without the loop changing.
 *
 * The dispatch is on the template's declared shape and never on its id:
 *
 *  - `promptMode: 'audio'` gets a `Presenter` that plays it and returns the end
 *    of playback.
 *  - `expected.tempoBpm` present means timed, so a run of the metronome is
 *    started and its `gridStartMs` goes onto the spec.
 *  - a node the tree marks `sustainSensitive` forces the app piano into dry
 *    mode, because that is what makes the drill audible at all.
 *  - anything else is on screen when it is painted, which is what the runner
 *    already assumed.
 *
 * Slice 7 found the first real breach of "drills are data" in this file, and it
 * is worth keeping the shape of it in mind. `withGrid` used to start the
 * metronome for `PULSE_BEATS` beats, a constant belonging to the pulse drill,
 * which was correct for exactly as long as there was one timed drill. The legato
 * line is nine notes over four beats, so it would have been counted against a
 * click that ran twice as long as the pattern. The grid a drill is played
 * against has to come from that drill's own expected events, and now does.
 */

import { runner } from '../grade/index.ts';
import type { ExpectedPerformance, PendingPrompt, Tolerances } from '../grade/index.ts';
import { COUNT_IN_BEATS, session } from '../audio/index.ts';
import { nodeById } from '../tree.ts';
import { instantiate } from './types.ts';
import type { DrillItem, DrillParams, Rng } from './types.ts';
import { templateForItem } from './registry.ts';

/**
 * The item as this rep asks it: the same id and the same nodes, with whatever
 * varies per rep filled in. `practice.current` holds this rather than the pool
 * item, so the screen renders the prompt that was actually played and the log
 * still keys on the item that was scheduled.
 */
export function prepareItem<P extends DrillParams>(
  item: DrillItem<P>,
  rng: Rng = Math.random
): DrillItem<P> {
  const template = templateForItem(item);
  if (!template.prepare) return item;
  // The registry erases a template's param type (`registry.ts`), and a template
  // only ever receives params from its own pool, so the cast back loses nothing
  // that was being checked.
  return { ...item, params: template.prepare(item.params, rng) as P };
}

export interface PresentOptions {
  rng?: Rng;
  /**
   * Tolerance overrides from settings, merged over the template's own. This is
   * how a number architecture.md section 9 expects to be wrong gets moved
   * without editing a drill: the legato band is the first one to use it.
   */
  tolerances?: Partial<Tolerances>;
}

/**
 * Prepare an item, deliver its prompt, and arm the runner for it. Returns the
 * prepared item so the caller can show the same rep it just started.
 */
export function presentItem(item: DrillItem, opts: PresentOptions = {}): DrillItem {
  const prepared = prepareItem(item, opts.rng ?? Math.random);
  const template = templateForItem(prepared);
  const prompt = instantiate(template, prepared, opts.tolerances);

  // Before anything sounds. architecture.md section 6: "Every `sustainSensitive:
  // true` node MUST route playback through the app piano", and the app piano is
  // only honest about separation in dry mode.
  if (isSustainSensitive(prepared.nodeIds)) session.setMode('dry');

  if (template.promptMode === 'audio') {
    runner.arm(prompt, audioPresenter(template.view(prepared.params).audition));
    return prepared;
  }

  if (prompt.expected.tempoBpm !== undefined) {
    runner.arm(withGrid(prompt));
    return prepared;
  }

  runner.arm(prompt);
  return prepared;
}

/**
 * Does this item exercise a node whose skill is note separation?
 *
 * Read from the tree rather than from a list of drill ids, so the rule arrives
 * with the node instead of with the drill: eleven of the tree's nodes are marked
 * `sustainSensitive` and only one of them is in V1
 * (`AudioOut.SUSTAIN_SENSITIVE_V1_NODE`, which names it for grepping). The other
 * ten get the same treatment for free on the day they get a drill.
 */
export function isSustainSensitive(nodeIds: readonly string[]): boolean {
  return nodeIds.some((id) => nodeById(id)?.sustainSensitive === true);
}

/**
 * Play the prompt, and report when it finished on the MIDI clock.
 *
 * The wait is what keeps the screen honest. Playback is scheduled ahead on the
 * audio clock, so the end of it is known the instant it starts, and resolving
 * straight away would put the runner in `waiting` while the notes were still
 * sounding: the user would be told to answer a prompt that had not finished
 * being asked. The value resolved is always the scheduled end, never the frame
 * that noticed it, so a late frame delays the word on screen and cannot move the
 * measurement.
 *
 * With no audio session there is nothing to play and nothing to wait for, so the
 * rep opens at the paint. That rep is unanswerable and the screen says why; the
 * alternative, refusing to arm, strands the practice loop with no way forward.
 */
function audioPresenter(pitches: readonly number[]) {
  return async (paintedAt: number): Promise<number> => {
    const played = session.playSequence(pitches);
    if (!played) return paintedAt;
    await waitUntil(played.endsAtMs);
    return played.endsAtMs;
  };
}

/**
 * Resolve once the MIDI clock reaches `ts`. On animation frames rather than a
 * timer, like every other wait in this app: a background tab throttles timers to
 * one a second, and this one sits between the user and the next prompt.
 */
function waitUntil(ts: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (now: number) => {
      if (now >= ts) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * How many beats of click a performance needs: enough for its last note to have
 * one under it.
 *
 * Read off `atBeat` rather than taken from a constant, for the reason in the
 * header. Eight quarter notes give eight beats and nine eighth notes give five,
 * and neither drill has to know that the other exists.
 */
export function gridBeatsOf(expected: ExpectedPerformance): number {
  let last = 0;
  expected.events.forEach((event, i) => {
    last = Math.max(last, event.atBeat ?? i);
  });
  return Math.max(1, Math.floor(last) + 1);
}

/**
 * Start the metronome and put the grid on the spec.
 *
 * The count-in is what makes this possible: the clicks are scheduled ahead of
 * real time, so beat 0 is known several seconds before it arrives and the grader
 * has its grid from the moment the prompt is armed. If audio has not been
 * started there is no clock offset, and the rep is armed without a grid: it
 * grades identity, reports meaningless timing, and the screen says to start
 * audio.
 */
function withGrid(prompt: PendingPrompt): PendingPrompt {
  const plan = session.startPulse({
    bpm: prompt.expected.tempoBpm ?? 100,
    countInBeats: COUNT_IN_BEATS,
    beats: gridBeatsOf(prompt.expected),
  });
  return plan ? { ...prompt, gridStartMs: plan.gridStartMs } : prompt;
}

/**
 * Stop whatever the last prompt started. Called before the next item and when a
 * session ends, so a metronome can never outlive the rep it was counting.
 */
export function stopPresentation(): void {
  session.stopPulse();
}
