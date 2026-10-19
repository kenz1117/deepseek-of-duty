/* =========================================================================
   Input: pointer lock, keyboard, mouse deltas with a per-frame accumulator.
   ========================================================================= */

export function createInput(domElement) {
  const keys = new Set();
  const pressed = new Set();      // edge-triggered this frame
  const mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false };
  let locked = false;
  let sensitivity = 1.0;
  const listeners = { lock: [], unlock: [], key: [] };

  function onKeyDown(e) {
    if (!keys.has(e.code)) {
      pressed.add(e.code);
      for (const fn of listeners.key) fn(e.code, e);
    }
    keys.add(e.code);
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  }
  function onKeyUp(e) { keys.delete(e.code); }
  function onMouseDown(e) {
    if (!locked) return;
    if (e.button === 0) { mouse.left = true; mouse.leftPressed = true; }
    if (e.button === 2) mouse.right = true;
  }
  function onMouseUp(e) {
    if (e.button === 0) mouse.left = false;
    if (e.button === 2) mouse.right = false;
  }
  function onMouseMove(e) {
    if (!locked) return;
    mouse.dx += e.movementX || 0;
    mouse.dy += e.movementY || 0;
  }
  function onContext(e) { e.preventDefault(); }
  function onPointerLockChange() {
    const was = locked;
    locked = document.pointerLockElement === domElement;
    if (locked && !was) { mouse.left = mouse.right = false; for (const f of listeners.lock) f(); }
    if (!locked && was) { keys.clear(); mouse.left = mouse.right = false; for (const f of listeners.unlock) f(); }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('contextmenu', onContext);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('blur', () => { keys.clear(); mouse.left = false; mouse.right = false; });

  const api = {
    keys, mouse, listeners,
    get locked() { return locked; },
    get sensitivity() { return sensitivity; },
    set sensitivity(v) { sensitivity = v; },
    down(code) { return keys.has(code); },
    pressedOnce(code) { return pressed.has(code); },
    lock() {
      if (!domElement.requestPointerLock) return;
      // requestPointerLock can throw or reject (no gesture, iframe, headless);
      // never let that become an unhandled rejection in the frame loop.
      try {
        const p = domElement.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) {
          p.catch(() => {
            try {
              const q = domElement.requestPointerLock();
              if (q && q.catch) q.catch(() => {});
            } catch (e) { /* ignore */ }
          });
        }
      } catch (e) {
        try { domElement.requestPointerLock(); } catch (e2) { /* ignore */ }
      }
    },
    unlock() { if (document.pointerLockElement) document.exitPointerLock(); },
    consumeMouse() {
      const out = { dx: mouse.dx, dy: mouse.dy, leftPressed: mouse.leftPressed };
      mouse.dx = 0; mouse.dy = 0; mouse.leftPressed = false;
      return out;
    },
    endFrame() { pressed.clear(); },
    on(evt, fn) { listeners[evt] && listeners[evt].push(fn); },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('contextmenu', onContext);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
    },
  };
  return api;
}
