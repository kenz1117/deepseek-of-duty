/* =========================================================================
   Cold-open video slot.

   Plays a generated clip before the in-engine cinematic. Everything is
   optional: a missing file (404), a blocked autoplay or a corrupt stream just
   calls the done callback, so the campaign never stalls on a missing asset.
   ========================================================================= */

export function createVideoIntro() {
  const root = document.getElementById('video-layer');
  const el = document.getElementById('video-el');
  let onDone = null;
  let playing = false;
  let guard = 0;

  function finish() {
    if (!playing) return;
    playing = false;
    clearTimeout(guard);
    try { el.pause(); } catch (e) { /* ignore */ }
    root?.classList.add('hidden');
    root?.setAttribute('aria-hidden', 'true');
    const done = onDone;
    onDone = null;
    if (done) done();
  }

  function play(src, done) {
    if (!root || !el) { if (done) done(); return; }
    if (playing) finish();
    playing = true;
    onDone = done || null;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    el.onended = finish;
    el.onerror = finish;
    el.src = src;
    el.muted = false;
    el.volume = 0.55;
    const p = el.play();
    if (p && p.catch) {
      p.catch(() => {
        // autoplay with sound blocked: fall back to muted playback, then give up
        el.muted = true;
        const q = el.play();
        if (q && q.catch) q.catch(() => { if (el.readyState === 0) finish(); });
      });
    }
    // never let a stalled network hold the campaign hostage
    guard = setTimeout(() => { if (playing && el.readyState === 0) finish(); }, 2600);
    return true;
  }

  function skip() { finish(); }

  document.getElementById('video-skip')?.addEventListener('click', (e) => {
    e.preventDefault();
    skip();
  });

  return {
    play, skip, finish,
    get playing() { return playing; },
  };
}
