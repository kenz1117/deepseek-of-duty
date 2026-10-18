#!/usr/bin/env node
/**
 * Local smoke test for server/leaderboard.mjs.
 *
 * Starts the service on 127.0.0.1:8788 with an isolated temp data directory,
 * exercises health/ticket/submit/duplicate/validation/board, then kills the
 * process and removes the temp directory. Exits 1 on any failed assertion.
 *
 * Usage: node tools/lb-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server', 'leaderboard.mjs');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = 'smoke-client-0001';

let child = null;
let tempDir = null;
let failures = 0;
let stdoutTail = '';
let stderrTail = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTail(current, chunk, maxLines = 30) {
  const lines = (current + chunk).split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function check(label, condition, details = '') {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${details ? ` — ${details}` : ''}`);
  }
}

async function request(
  pathname,
  { method = 'GET', body = null, timeoutMs = 5000, headers: extraHeaders = null } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: 'application/json',
      'X-Client-Id': CLIENT_ID,
      ...(extraHeaders || {}),
    };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth() {
  let lastError = 'no attempt';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child && child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\n${stderrTail}`);
    }
    try {
      const response = await request('/api/health', { timeoutMs: 1000 });
      if (response.status === 200 && response.body && response.body.ok === true) {
        return response;
      }
      lastError = `status ${response.status} body ${response.text.slice(0, 200)}`;
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`server did not become healthy: ${lastError}\n${stderrTail}`);
}

async function getTicket(ip = null) {
  return request('/api/ticket', { headers: ip ? { 'X-Forwarded-For': ip } : null });
}

function tamperSig(sig) {
  const first = sig.length > 0 ? sig[0] : '0';
  return `${first === '0' ? '1' : '0'}${sig.slice(1)}`;
}

async function submit(run, { sig, ticket, issuedAt, name = 'SMOKE', ip = null } = {}) {
  const extraHeaders = ip ? { 'X-Forwarded-For': ip } : null;
  const issued = ticket === undefined || issuedAt === undefined
    ? (await getTicket(ip)).body
    : null;
  const payload = {
    ticket: ticket === undefined ? issued && issued.ticket : ticket,
    issuedAt: issuedAt === undefined ? issued && issued.issuedAt : issuedAt,
    sig: sig === undefined ? issued && issued.sig : sig,
    name,
    run,
  };
  return request('/api/runs', { method: 'POST', body: payload, headers: extraHeaders });
}

function legalRun(runId = 'smoke-run-0001') {
  return {
    runId,
    mode: 'rotation',
    score: 1250,
    kills: 10,
    wave: 2,
    durationMs: 20000,
    headshots: 4,
    shots: 100,
    hits: 40,
    challengesDone: 1,
  };
}

async function cleanup() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      sleep(3000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), sleep(2000)]);
    }
  }
  if (child) {
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      /* ignore */
    }
  }
  if (tempDir) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`WARN  failed to remove temp directory: ${error.message}`);
    }
  }
}

async function main() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dod-lb-smoke-'));
  const dataDir = path.join(tempDir, 'data');

  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      LB_SECRET: 'test',
      LB_DATA_DIR: dataDir,
      LB_ORIGINS: 'http://127.0.0.1:5173',
      LB_ALLOW_UNSIGNED: '0',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk.toString());
  });

  console.log(`[smoke] starting server on ${BASE} (data: ${dataDir})`);
  const health = await waitForHealth();

  check('GET /api/health 返回 200 + ok:true', health.status === 200 && health.body.ok === true);
  check(
    'health.modes 包含四种模式',
    Array.isArray(health.body.modes) &&
      ['rotation', 'survival', 'defend', 'extract'].every((mode) => health.body.modes.includes(mode)),
    JSON.stringify(health.body.modes)
  );
  check(
    'health.version / uptimeSec 字段类型正确',
    typeof health.body.version === 'string' && typeof health.body.uptimeSec === 'number'
  );

  const ticket = (await getTicket()).body;
  check(
    'GET /api/ticket 返回 ticket/issuedAt/sig',
    ticket &&
      typeof ticket.ticket === 'string' &&
      ticket.ticket.length > 0 &&
      Number.isInteger(ticket.issuedAt) &&
      typeof ticket.sig === 'string' &&
      /^[0-9a-f]{64}$/.test(ticket.sig),
    JSON.stringify(ticket)
  );

  const first = await submit(legalRun());
  check(
    '合法 run 提交返回 200 + ok:true',
    first.status === 200 && first.body && first.body.ok === true,
    `status=${first.status} body=${first.text}`
  );
  check('首次提交 rank=1', first.body && first.body.rank === 1, JSON.stringify(first.body));
  check(
    '首次提交返回 top 且包含该 runId',
    first.body &&
      Array.isArray(first.body.top) &&
      first.body.top.length === 1 &&
      first.body.top[0].runId === 'smoke-run-0001',
    JSON.stringify(first.body && first.body.top)
  );

  const duplicate = await submit(legalRun());
  check(
    '重复 runId 提交仍返回 200',
    duplicate.status === 200 && duplicate.body && duplicate.body.ok === true,
    `status=${duplicate.status} body=${duplicate.text}`
  );

  const boardAfterDuplicate = (await request('/api/board?mode=rotation&limit=8')).body;
  check(
    '重复 runId 不重复计数（total=1）',
    boardAfterDuplicate &&
      boardAfterDuplicate.ok === true &&
      boardAfterDuplicate.total === 1 &&
      Array.isArray(boardAfterDuplicate.top) &&
      boardAfterDuplicate.top.length === 1,
    JSON.stringify(boardAfterDuplicate)
  );

  const badScoreRun = { ...legalRun('smoke-run-bad1'), score: 2_000_001 };
  const badScore = await submit(badScoreRun);
  check(
    '越界 score 返回 400 + ok:false',
    badScore.status === 400 && badScore.body && badScore.body.ok === false,
    `status=${badScore.status} body=${badScore.text}`
  );

  const wrongTicket = (await getTicket()).body;
  const wrongSig = await submit(legalRun('smoke-run-badsig'), {
    ticket: wrongTicket.ticket,
    issuedAt: wrongTicket.issuedAt,
    sig: tamperSig(wrongTicket.sig),
  });
  check(
    '错误 sig 返回 400 + ok:false',
    wrongSig.status === 400 && wrongSig.body && wrongSig.body.ok === false,
    `status=${wrongSig.status} body=${wrongSig.text}`
  );

  const board = await request('/api/board?mode=rotation&limit=8');
  check(
    'GET /api/board 返回 200 + 1 条记录',
    board.status === 200 &&
      board.body &&
      board.body.ok === true &&
      board.body.total === 1 &&
      Array.isArray(board.body.top) &&
      board.body.top.length === 1,
    `status=${board.status} body=${board.text}`
  );
  check(
    'board 条目字段与分数正确',
    board.body &&
      board.body.top &&
      board.body.top[0] &&
      board.body.top[0].name === 'SMOKE' &&
      board.body.top[0].score === 1250 &&
      board.body.top[0].kills === 10 &&
      board.body.top[0].wave === 2 &&
      typeof board.body.top[0].ts === 'number',
    JSON.stringify(board.body && board.body.top)
  );

  // Softer duration floor: wave 1 with a 5 s run must be accepted.
  const fastRun = {
    runId: 'smoke-run-fast1',
    mode: 'survival',
    score: 100,
    kills: 1,
    wave: 1,
    durationMs: 5000,
    headshots: 0,
    shots: 5,
    hits: 1,
    challengesDone: 0,
  };
  const fast = await submit(fastRun);
  check(
    'wave=1 / durationMs=5000 的速死局可提交（软时长规则）',
    fast.status === 200 && fast.body && fast.body.ok === true && fast.body.rank === 1,
    `status=${fast.status} body=${fast.text}`
  );

  // A 1 s record is still rejected by the minimum duration.
  const tooFast = await submit({ ...fastRun, runId: 'smoke-run-fast2', durationMs: 1000 });
  check(
    'durationMs=1000 仍返回 400（最低 5 秒）',
    tooFast.status === 400 && tooFast.body && tooFast.body.ok === false,
    `status=${tooFast.status} body=${tooFast.text}`
  );

  // Personal rank can be requested with ?cid=; the query wins over the header.
  const ownRank = await request(`/api/board?mode=survival&limit=8&cid=${CLIENT_ID}`);
  check(
    'GET /api/board?cid=<本人> 返回 rank=1',
    ownRank.status === 200 && ownRank.body && ownRank.body.rank === 1,
    `status=${ownRank.status} body=${ownRank.text}`
  );
  const otherRank = await request('/api/board?mode=survival&limit=8&cid=other-client-0001');
  check(
    'GET /api/board?cid=<未上榜> 返回 rank=null',
    otherRank.status === 200 && otherRank.body && otherRank.body.rank === null,
    `status=${otherRank.status} body=${otherRank.text}`
  );

  // -------------------------------------------------------------------------
  // Pagination: seed 25 entries in `defend`. Each seed uses a distinct
  // X-Forwarded-For so the per-IP submission bucket does not reject the fixture.
  // -------------------------------------------------------------------------
  const PAGE_MODE = 'defend';
  let seeded = 0;
  let seedFailure = '';
  for (let i = 1; i <= 25; i += 1) {
    const seededRun = {
      runId: `page-run-${String(i).padStart(4, '0')}`,
      mode: PAGE_MODE,
      score: 1000 + i * 100,
      kills: 5,
      wave: 1,
      durationMs: 5000,
      headshots: 1,
      shots: 20,
      hits: 5,
      challengesDone: 0,
    };
    const response = await submit(seededRun, { ip: `10.10.0.${i}`, name: 'PAGE' });
    if (response.status === 200 && response.body && response.body.ok === true) {
      seeded += 1;
    } else {
      seedFailure = `i=${i} status=${response.status} body=${response.text}`;
      break;
    }
  }
  check(
    '造 25 条分页数据',
    seeded === 25,
    `seeded=${seeded}${seedFailure ? ` ${seedFailure}` : ''}`
  );

  const page1 = await request(`/api/board?mode=${PAGE_MODE}&limit=20&offset=0`);
  check(
    '分页第 1 页：offset=0 返回 20 条 / nextOffset=20 / hasMore=true / 首条 rank=1',
    page1.status === 200 &&
      page1.body &&
      page1.body.ok === true &&
      page1.body.total === 25 &&
      Array.isArray(page1.body.top) &&
      page1.body.top.length === 20 &&
      page1.body.nextOffset === 20 &&
      page1.body.hasMore === true &&
      page1.body.top[0].rank === 1 &&
      page1.body.top[19].rank === 20 &&
      page1.body.rank === 1,
    `status=${page1.status} body=${page1.text.slice(0, 500)}`
  );

  const page2 = await request(`/api/board?mode=${PAGE_MODE}&limit=20&offset=20`);
  check(
    '分页第 2 页：offset=20 返回 5 条 / nextOffset=null / hasMore=false / 首条 rank=21',
    page2.status === 200 &&
      page2.body &&
      page2.body.ok === true &&
      page2.body.total === 25 &&
      Array.isArray(page2.body.top) &&
      page2.body.top.length === 5 &&
      page2.body.nextOffset === null &&
      page2.body.hasMore === false &&
      page2.body.top[0].rank === 21 &&
      page2.body.top[4].rank === 25,
    `status=${page2.status} body=${page2.text.slice(0, 500)}`
  );

  check(
    '两页 total 均为 25',
    page1.body && page2.body && page1.body.total === 25 && page2.body.total === 25,
    `page1.total=${page1.body && page1.body.total} page2.total=${page2.body && page2.body.total}`
  );
}

let exitCode = 1;
try {
  await main();
  exitCode = failures > 0 ? 1 : 0;
} catch (error) {
  failures += 1;
  console.error(`FAIL  smoke test crashed — ${error && error.message ? error.message : error}`);
  if (stderrTail) console.error(`[server stderr]\n${stderrTail}`);
  if (stdoutTail) console.error(`[server stdout]\n${stdoutTail}`);
  exitCode = 1;
} finally {
  await cleanup();
  console.log(`[smoke] ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(exitCode);
}
