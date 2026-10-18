/* =========================================================================
   RESULTS / DAILY / LEADERBOARD UI
   Pure DOM, no framework. The death overlay visibility is owned by main.js;
   createResults().show() only fills content and fades the internal result
   panels in via #death.res-open.
   ========================================================================= */

const $ = (id) => document.getElementById(id);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(n) {
  return String(Math.max(0, n | 0)).padStart(2, '0');
}

function formatScore(v) {
  return num(v).toLocaleString('en-US');
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return '--:--';
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function formatAccuracy(v) {
  if (v === null || v === undefined || v === '') return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.max(0, Math.min(999, Math.round(pct)))}%`;
}

function dailyTotals(container, done, total) {
  const label = `${done}/${total}`;
  if (container.id === 'menu-daily-list') {
    const count = $('menu-daily-count');
    if (count) count.textContent = label;
  }
  if (container.id === 'res-daily-list') {
    const count = $('res-daily-progress');
    if (count) count.textContent = label;
  }
}

/* -------------------------------------------------------------- leaderboard */
export function renderBoardList(container, board) {
  if (!container) return;
  container.textContent = '';
  container.title = '本局 Top 8 · 滚轮或 PageDown 下翻';

  const b = Array.isArray(board) ? { entries: board } : (board || {});
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 100);
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'res-board-empty';
    li.textContent = '暂无记录 · 你可以是第一个';
    container.appendChild(li);
    return;
  }

  const currentRunId = typeof b.currentRunId === 'string' ? b.currentRunId
    : typeof b.runId === 'string' ? b.runId : '';
  const currentRank = num(b.rank, 0);

  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const li = document.createElement('li');
    li.className = 'res-board-row';

    const rank = num(e.rank, i + 1);
    const isYou = (!!currentRunId && e.runId === currentRunId) ||
      (currentRank > 0 && rank === currentRank);
    if (isYou) {
      li.classList.add('is-you');
      li.setAttribute('aria-current', 'true');
    }

    const r = document.createElement('span');
    r.className = 'res-board-rank';
    r.textContent = String(rank);

    const name = document.createElement('span');
    name.className = 'res-board-name';
    name.textContent = String(e.name || 'UNKNOWN');
    name.title = String(e.name || 'UNKNOWN');

    const score = document.createElement('span');
    score.className = 'res-board-score';
    score.textContent = formatScore(e.score);

    const wave = document.createElement('span');
    wave.className = 'res-board-wave';
    wave.textContent = String(num(e.wave, 1));

    const kills = document.createElement('span');
    kills.className = 'res-board-kills';
    kills.textContent = String(num(e.kills, 0));

    li.append(r, name, score, wave, kills);
    container.appendChild(li);
  });
}

/* ------------------------------------------------------------- menu board */
export function renderMenuBoard(container, board, { best = null, syncedAt = 0, pending = 0, total = 0, loading = false, done = false } = {}) {
  if (!container) return;
  container.textContent = '';
  container.title = 'TOP 100 · 滚动到底加载下一页';

  const b = Array.isArray(board) ? { entries: board } : (board || {});
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 100);
  const currentRank = num(b.rank, 0);

  const sourceEl = $('menu-board-source');
  if (sourceEl) {
    const source = b.source === 'online' ? 'online' : b.source === 'cache' ? 'cache' : 'local';
    sourceEl.textContent = source === 'online' ? 'ONLINE' : source === 'cache' ? 'CACHE' : 'LOCAL';
    sourceEl.className = `mb-source ${source}`;
  }

  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'mb-empty';
    empty.textContent = loading ? '加载中…' : '暂无记录 · 成为第一个上榜的人';
    container.appendChild(empty);
  } else {
    entries.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const li = document.createElement('li');
      li.className = 'mb-row';

      const rank = num(e.rank, i + 1);
      if (currentRank > 0 && rank === currentRank) {
        li.classList.add('is-you');
        li.setAttribute('aria-current', 'true');
      }

      const r = document.createElement('span');
      r.className = 'mb-rank';
      r.textContent = String(rank);

      const name = document.createElement('span');
      name.className = 'mb-name';
      name.textContent = String(e.name || 'UNKNOWN');
      name.title = String(e.name || 'UNKNOWN');

      const score = document.createElement('span');
      score.className = 'mb-score';
      score.textContent = formatScore(e.score);

      const wave = document.createElement('span');
      wave.className = 'mb-wave';
      wave.textContent = String(num(e.wave, 1));

      const kills = document.createElement('span');
      kills.className = 'mb-kills';
      kills.textContent = String(num(e.kills, 0));

      li.append(r, name, score, wave, kills);
      container.appendChild(li);
    });
  }

  if (entries.length) {
    const totalCount = Math.max(num(b.total, 0), total, entries.length);
    const more = document.createElement('li');
    more.className = 'mb-more';
    if (loading) more.textContent = '加载中…';
    else if (done) more.textContent = `已到底 · 共 ${totalCount} 名`;
    else more.textContent = `继续下滑加载 · ${entries.length}/${totalCount}`;
    container.appendChild(more);
  }

  const meEl = $('menu-board-me');
  if (meEl) {
    let me = '最佳 —';
    if (best && best.score !== null && best.score !== undefined && Number.isFinite(Number(best.score))) {
      const wave = best.wave !== null && best.wave !== undefined ? ` · W${num(best.wave, 1)}` : '';
      me = `最佳 ${formatScore(best.score)}${wave}`;
    }
    if (currentRank > 0) me += ` · #${currentRank}`;
    // The board is a snapshot, not a live session list: always say how fresh it is.
    if (syncedAt > 0) {
      const d = new Date(syncedAt);
      me += ` · 同步 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    } else {
      me += ' · 未同步';
    }
    if (pending > 0) me += ` · 待补交 ${pending}`;
    meEl.textContent = me;
    meEl.title = me;
  }
}

/* ------------------------------------------------------------------- daily */
export function renderDailyList(container, daily, { compact = false } = {}) {
  if (!container) return;
  // The menu deck wants the full challenge description at desktop size; CSS
  // collapses/hides it on short viewports. Keep compact for other callers.
  const inDeck = !!(container.closest && container.closest('#deck-daily'));
  const useCompact = compact && !inDeck;
  container.textContent = '';

  const defs = Array.isArray(daily && daily.defs) ? daily.defs : [];
  const pMap = (daily && daily.p) || {};
  const doneMap = (daily && daily.done) || {};
  let doneCount = 0;

  if (!defs.length) {
    dailyTotals(container, 0, 0);
    const li = document.createElement('li');
    li.className = 'md-empty';
    li.textContent = '暂无挑战 · 稍后刷新';
    container.appendChild(li);
    return;
  }

  for (const d of defs) {
    if (!d || typeof d !== 'object') continue;
    const id = d.id != null ? d.id : '';
    const goal = num(d.goal, 0);
    const rawP = num(pMap[id], 0);
    const prog = Math.max(0, rawP);
    const isDone = !!doneMap[id] || (goal > 0 && prog >= goal);
    if (isDone) doneCount++;

    const shownProg = goal > 0
      ? `${Math.min(prog, goal)}/${goal}`
      : (isDone ? '完成' : (prog > 0 ? String(prog) : ''));
    const pct = goal > 0 ? Math.min(100, (Math.min(prog, goal) / goal) * 100)
      : (isDone ? 100 : 0);

    const li = document.createElement('li');
    li.className = `md-item${useCompact ? ' compact' : ' full'}${isDone ? ' done' : ''}`;
    if (id !== '') li.dataset.id = String(id);

    const check = document.createElement('i');
    check.className = 'md-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = isDone ? '✓' : '';

    const body = document.createElement('div');
    body.className = 'md-body';

    const row = document.createElement('div');
    row.className = 'md-row';

    const title = document.createElement('span');
    title.className = 'md-title';
    title.textContent = String(d.title || id || 'DAILY');

    const progEl = document.createElement('span');
    progEl.className = 'md-prog';
    progEl.textContent = shownProg;

    row.append(title, progEl);
    body.appendChild(row);

    if (!useCompact) {
      const desc = document.createElement('p');
      desc.className = 'md-desc';
      desc.textContent = String(d.desc || '');
      body.appendChild(desc);

      const bar = document.createElement('span');
      bar.className = 'md-bar';
      const fill = document.createElement('i');
      fill.style.width = `${pct.toFixed(1)}%`;
      bar.appendChild(fill);
      body.appendChild(bar);
    }

    li.append(check, body);
    container.appendChild(li);
  }

  dailyTotals(container, doneCount, defs.length);
}

/* ---------------------------------------------------------------- factory */
export function createResults({ onRedeploy, onCallsignChange } = {}) {
  const death = $('death');
  const els = {
    inner: death ? death.querySelector('.death-inner') : null,
    redeploy: $('redeploy'),
    callsign: $('res-callsign'),
    submit: $('res-submit-state'),
    boardList: $('res-board-list'),
    boardSource: $('res-board-source'),
    dailyList: $('res-daily-list'),
    dailyProgress: $('res-daily-progress'),
    newBest: $('res-newbest'),
    newBestText: $('res-newbest-text'),
    kills: $('final-kills'),
    wave: $('final-wave'),
    score: $('final-score'),
    headshots: $('res-headshots'),
    accuracy: $('res-accuracy'),
    time: $('res-time'),
  };

  let wantFocus = false;
  let lastCallsignSent = '';
  let lastRunId = '';

  function focusRedeploy() {
    if (!death || death.classList.contains('hidden') || !els.redeploy) return false;
    try { els.redeploy.focus({ preventScroll: true }); }
    catch (e) { try { els.redeploy.focus(); } catch (e2) { /* noop */ } }
    wantFocus = false;
    return true;
  }

  if (death && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => {
      if (wantFocus && !death.classList.contains('hidden')) focusRedeploy();
    });
    mo.observe(death, { attributes: true, attributeFilter: ['class'] });
  }

  function emitCallsign() {
    if (!els.callsign || typeof onCallsignChange !== 'function') return;
    const value = String(els.callsign.value || '').trim().slice(0, 12);
    if (els.callsign.value !== value) els.callsign.value = value;
    if (value === lastCallsignSent) return;
    lastCallsignSent = value;
    try { onCallsignChange(value); }
    catch (err) { console.error('[results] callsign change failed', err); }
  }

  if (els.callsign) {
    els.callsign.addEventListener('change', emitCallsign);
    els.callsign.addEventListener('blur', emitCallsign);
    els.callsign.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      emitCallsign();
      els.callsign.blur();
    });
  }

  if (death) {
    death.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !death.classList.contains('res-open')) return;
      const active = document.activeElement;
      if (!e.shiftKey && active === els.redeploy && els.callsign) {
        e.preventDefault();
        els.callsign.focus();
      } else if (e.shiftKey && active === els.callsign && els.redeploy) {
        e.preventDefault();
        els.redeploy.focus();
      }
    });
  }

  if (els.redeploy && typeof onRedeploy === 'function') {
    els.redeploy.addEventListener('click', () => {
      try { onRedeploy(); }
      catch (err) { console.error('[results] redeploy failed', err); }
    });
  }

  function setBoard(board) {
    const b = board && typeof board === 'object' ? board : null;
    const online = !!b && b.source === 'online';
    if (els.boardSource) {
      els.boardSource.textContent = online ? 'ONLINE' : 'LOCAL';
      els.boardSource.classList.toggle('online', online);
      els.boardSource.classList.toggle('local', !online);
      if (b && b.updatedAt) {
        const d = new Date(num(b.updatedAt));
        els.boardSource.title = `更新于 ${d.toLocaleString('zh-CN')}`;
      } else {
        els.boardSource.removeAttribute('title');
      }
    }
    if (b && typeof b.currentRunId === 'string') lastRunId = b.currentRunId;
    if (b && typeof b.runId === 'string') lastRunId = b.runId;
    renderBoardList(els.boardList, b ? { ...b, currentRunId: b.currentRunId || lastRunId } : null);
  }

  function setSubmitState(state, msg) {
    if (!els.submit) return;
    const key = String(state || '').toLowerCase();
    const message = String(msg || '').trim();
    const known = {
      sending: '提交中…', pending: '提交中…', loading: '提交中…',
      done: '已上榜', online: '已上榜', submitted: '已上榜', ok: '已上榜',
      local: '离线：已存本地', offline: '离线：已存本地',
      failed: '提交失败', error: '提交失败',
    };
    let cls = 'pending';
    if (key === 'online' || key === 'submitted' || key === 'ok' || key === 'done') cls = 'online';
    if (key === 'local' || key === 'offline') cls = 'local';
    if (key === 'failed' || key === 'error') cls = 'error';

    const hay = `${key} ${message}`;
    if (/本地|离线/.test(hay)) cls = 'local';
    else if (/失败|error|fail/i.test(message)) cls = 'error';
    else if (/已上榜|online|done/i.test(message)) cls = 'online';

    els.submit.textContent = message || known[key] || String(state || '');
    els.submit.className = `res-submit-state res-submit--${cls}`;
    els.submit.dataset.state = key || cls;
  }

  function setNewBest(isBest, prevBest) {
    if (!els.newBest) return;
    if (!isBest) {
      els.newBest.classList.add('hidden');
      els.newBest.classList.remove('show');
      return;
    }
    if (els.newBestText) els.newBestText.textContent = 'NEW RECORD · 新纪录';
    els.newBest.classList.remove('hidden');
    // restart the glow animation on repeat calls
    els.newBest.classList.remove('show');
    void els.newBest.offsetWidth;
    els.newBest.classList.add('show');
    if (prevBest !== undefined && prevBest !== null) {
      els.newBest.title = `PREVIOUS BEST ${formatScore(prevBest)}`;
    } else {
      els.newBest.removeAttribute('title');
    }
  }

  function show(payload = {}) {
    if (!death) return;
    const p = payload && typeof payload === 'object' ? payload : {};
    death.classList.add('res-open');

    if (els.kills) els.kills.textContent = String(num(p.kills, 0));
    if (els.wave) els.wave.textContent = String(num(p.wave, 1));
    if (els.score) els.score.textContent = formatScore(p.score);
    if (els.headshots) els.headshots.textContent = String(num(p.headshots, 0));
    if (els.accuracy) els.accuracy.textContent = formatAccuracy(p.accuracy);
    if (els.time) els.time.textContent = formatDuration(p.durationMs);

    if (els.callsign) {
      const value = String(p.callsign || '').slice(0, 12);
      els.callsign.value = value;
      lastCallsignSent = value.trim();
    }

    setSubmitState('sending', '提交中…');
    lastRunId = typeof p.runId === 'string' ? p.runId : '';
    setBoard(p.board || null);
    renderDailyList(els.dailyList, p.daily || { defs: [], p: {}, done: {} });
    setNewBest(!!p.isBest, p.prevBest);

    if (els.inner) els.inner.scrollTop = 0;
    wantFocus = true;
    if (!focusRedeploy()) requestAnimationFrame(() => { if (!focusRedeploy()) wantFocus = true; });
  }

  function hide() {
    if (!death) return;
    wantFocus = false;
    death.classList.remove('res-open');
  }

  return { show, hide, setBoard, setSubmitState, setNewBest };
}

/* ---------------------------------------------------------- menu mode brief */
/* The deck BRIEFING panel and the hidden prestart dialog are both updated by
   main.js when the mode changes. Mirror them into the standalone mode brief
   that now sits where START used to be, without requiring another main hook. */
function initModeBrief() {
  const root = $('mode-desc');
  if (!root) return;

  const out = {
    label: $('mode-desc-label'),
    title: $('mode-desc-title'),
    text: $('mode-desc-text'),
    threat: $('mode-desc-threat'),
    ao: $('mode-desc-ao'),
    contact: $('mode-desc-contact'),
  };
  const read = (id) => {
    const el = $(id);
    return el ? String(el.textContent || '').trim() : '';
  };
  let last = '';

  function paint(animate) {
    const label = read('prestart-mode') || read('brief-mode') || 'ROTATION';
    const title = read('prestart-title') || read('brief-title');
    const text = read('prestart-desc') || read('brief-note');
    const threat = read('brief-threat') || 'HIGH';
    const ao = read('brief-ao') || 'URBAN';
    const contact = read('brief-contact') || '∞';
    const key = [label, title, text, threat, ao, contact].join('\u0001');
    if (key === last) return;
    last = key;

    if (out.label) out.label.textContent = label;
    if (out.title) out.title.textContent = title;
    if (out.text) out.text.textContent = text;
    if (out.threat) {
      out.threat.textContent = threat;
      out.threat.classList.toggle('hot', threat !== 'LOW');
    }
    if (out.ao) out.ao.textContent = ao;
    if (out.contact) out.contact.textContent = contact;

    if (animate) {
      root.classList.remove('is-swap');
      void root.offsetWidth;
      root.classList.add('is-swap');
    }
  }

  paint(false);
  if (typeof MutationObserver === 'undefined') return;
  const watched = [
    'prestart-mode', 'prestart-title', 'prestart-desc',
    'brief-mode', 'brief-title', 'brief-threat', 'brief-ao', 'brief-contact',
  ];
  const mo = new MutationObserver(() => paint(true));
  for (const id of watched) {
    const el = $(id);
    if (el) {
      mo.observe(el, {
        childList: true, characterData: true, subtree: true,
        attributes: true, attributeFilter: ['class'],
      });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initModeBrief, { once: true });
} else {
  initModeBrief();
}
