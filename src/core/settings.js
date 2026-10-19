/* =========================================================================
   Persistent user settings (localStorage). Kept framework-free so the HUD,
   the controller and the engine can all share one plain object.
   ========================================================================= */

export const SETTINGS_KEY = 'dod.settings.v1';
export const TUTORIAL_KEY = 'dod.tutorial.v1';
export const PRESTART_KEY = 'dod.prestart.skip';

export const DEFAULT_SETTINGS = {
  sensitivity: 1.0,     // hip-fire mouse sensitivity multiplier
  adsSens: 0.58,        // ADS sensitivity multiplier (fraction of hip)
  fov: 78,              // vertical FOV, 70-100
  invertY: false,
  master: 0.58,         // master volume 0-1
  reduceMotion: false,  // damp head bob / shake
  quality: 'high',      // low | medium | high | ultra
  runMode: 'rotation',  // rotation | survival | defend | extract
  wayfinder: true,      // HUD area names + route marker to the apartment / backyard
  primary: 'm4',        // m4 | mk18 — which rifle you spawn with
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function sanitizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  s.sensitivity = clamp(Number(s.sensitivity) || 1, 0.2, 3);
  s.adsSens = clamp(Number(s.adsSens) || 0.58, 0.2, 1);
  s.fov = clamp(Number(s.fov) || 78, 70, 100);
  s.master = clamp(Number(s.master) || 0, 0, 1);
  s.invertY = !!s.invertY;
  s.reduceMotion = !!s.reduceMotion;
  if (!['low', 'medium', 'high', 'ultra'].includes(s.quality)) s.quality = 'high';
  if (!['rotation', 'survival', 'defend', 'extract'].includes(s.runMode)) s.runMode = 'rotation';
  s.wayfinder = s.wayfinder !== false;
  s.primary = s.primary === 'mk18' ? 'mk18' : 'm4';
  return s;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch (e) {
    /* private mode / storage disabled — run without persistence */
  }
}

export function tutorialDone() {
  try { return localStorage.getItem(TUTORIAL_KEY) === '1'; } catch (e) { return true; }
}
export function markTutorialDone() {
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch (e) { /* ignore */ }
}

export function prestartSkipped() {
  try { return localStorage.getItem(PRESTART_KEY) === '1'; } catch (e) { return false; }
}
export function setPrestartSkipped(v) {
  try {
    if (v) localStorage.setItem(PRESTART_KEY, '1');
    else localStorage.removeItem(PRESTART_KEY);
  } catch (e) { /* ignore */ }
}
