/* Fixed-step simulation with a bounded catch-up budget. Rendering stays on
   requestAnimationFrame; gameplay does not slow down merely because a frame
   took longer than 50 ms. */
export const SIM_STEP_S = 1 / 60;
export const MAX_SIM_STEPS = 5;

export function createFixedStepper(step = SIM_STEP_S, maxSteps = MAX_SIM_STEPS) {
  let accumulator = 0;
  return {
    advance(dt, update) {
      if (!(dt > 0) || typeof update !== 'function') return 0;
      accumulator += Math.min(dt, step * maxSteps);
      let steps = 0;
      while (accumulator + 1e-10 >= step && steps < maxSteps) {
        update(step);
        accumulator -= step;
        steps += 1;
      }
      // Never carry a spiral-of-death backlog into the next rendered frame.
      if (steps === maxSteps && accumulator >= step) accumulator %= step;
      return steps;
    },
    reset() { accumulator = 0; },
    get pending() { return accumulator; },
  };
}
