#!/usr/bin/env node
/**
 * Generate the missing campaign voice lines straight from the MiniMax
 * platform, using the account's own quota.
 *
 *   MINIMAX_CN_API_KEY=... node tools/gen-voices.mjs
 *
 * Optional: MINIMAX_GROUP_ID (appended as ?GroupId=…), MINIMAX_API_BASE
 * (default https://api.minimax.chat).
 *
 * Why a script instead of the shared connector: the connector's TTS path is
 * a shared upstream that returns 429 for everyone when it is saturated. The
 * platform API bills the account that owns the key, which is the point.
 *
 * The line texts are read from src/voice.js, so a recording can never drift
 * from the subtitle it belongs to, and the casting comes from VOICE_CAST in
 * the same file. Files that already exist are skipped, so the script is
 * safe to re-run and resumes where it left off.
 *
 * The API returns the audio as a HEX string, not base64 — decoding it as
 * base64 is what produced 32 broken mp3s the first time round.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { VOICE_LINES, VOICE_CAST } from '../src/voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.VOICE_OUT_DIR
  ? path.resolve(process.env.VOICE_OUT_DIR)
  : path.join(ROOT, 'public', 'audio', 'voice');
const KEY = process.env.MINIMAX_CN_API_KEY || '';
const BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimax.chat').replace(/\/$/, '');
const GROUP = process.env.MINIMAX_GROUP_ID || '';
const MODEL = process.env.MINIMAX_TTS_MODEL || 'speech-02-hd';

if (!KEY) {
  console.error('缺少 MINIMAX_CN_API_KEY。用法：');
  console.error('  MINIMAX_CN_API_KEY=你的key node tools/gen-voices.mjs');
  process.exit(2);
}

/* Which lines still need a recording: no file on disk, but a text to speak
 * (the text is also the browser-TTS fallback). */
const todo = Object.entries(VOICE_LINES)
  .filter(([id, v]) => v.text && v.speaker && VOICE_CAST[v.speaker]
    && !fs.existsSync(path.join(OUT_DIR, v.file)));

if (!todo.length) {
  console.log('所有台词录音已齐全，无需生成。');
  process.exit(0);
}

console.log(`待生成 ${todo.length} 条 → ${path.relative(ROOT, OUT_DIR)}/`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synthesize(text, cast) {
  const url = `${BASE}/v1/t2a_v2${GROUP ? `?GroupId=${encodeURIComponent(GROUP)}` : ''}`;
  const body = {
    model: MODEL,
    text,
    stream: false,
    voice_setting: {
      voice_id: cast.voice_id,
      speed: cast.speed,
      pitch: cast.pitch,
      vol: 1,
      emotion: 'neutral',
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    language_boost: 'Chinese',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text_res = await res.text();
  let json;
  try { json = JSON.parse(text_res); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.base_resp?.status_msg || json?.message || text_res.slice(0, 200);
    const err = new Error(`${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  if (json?.base_resp?.status_code) {
    const err = new Error(json.base_resp.status_msg || 'api error');
    err.status = json.base_resp.status_code;
    throw err;
  }
  const hex = json?.data?.audio;
  if (!hex) throw new Error('响应里没有 data.audio');
  return Buffer.from(hex, 'hex');   // HEX, not base64
}

/** Median F0 of a generated file — the voice print we cast against. */
function medianF0(file) {
  const pcm = spawnSync('ffmpeg', ['-v', 'quiet', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'],
    { maxBuffer: 1 << 28 });
  if (pcm.status !== 0 || !pcm.stdout.length) return null;
  const x = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length / 4);
  const SR = 8000, WIN = 256, HOP = 128, MIN_LAG = 20, MAX_LAG = 133;
  const vals = [];
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    let e = 0, mean = 0;
    for (let i = 0; i < WIN; i++) { e += x[s + i] * x[s + i]; mean += x[s + i]; }
    mean /= WIN;
    if (e / WIN < 0.0004) continue;
    let best = 0, bestLag = 0;
    for (let lag = MIN_LAG; lag < MAX_LAG; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < WIN; i++) acc += (x[s + i] - mean) * (x[s + i + lag] - mean);
      acc /= (WIN - lag);
      if (acc > best) { best = acc; bestLag = lag; }
    }
    if (!bestLag) continue;
    if (best / (e / WIN) < 0.3) continue;
    vals.push(SR / bestLag);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

let done = 0, failed = 0;
for (const [id, v] of todo) {
  const cast = VOICE_CAST[v.speaker];
  let buf = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      buf = await synthesize(v.text, cast);
      break;
    } catch (err) {
      const wait = attempt * 20;
      console.log(`  ${id} 第 ${attempt} 次失败：${err.message} → ${wait}s 后重试`);
      if (attempt === 5) break;
      await sleep(wait * 1000);
    }
  }
  if (!buf || !buf.length) { failed++; console.log(`FAIL ${id}`); continue; }
  const file = path.join(OUT_DIR, v.file);
  fs.writeFileSync(file, buf);
  const f0 = medianF0(file);
  done++;
  console.log(`OK   ${id.padEnd(18)} ${v.speaker.padEnd(9)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB  F0 ${f0 ? f0.toFixed(0) + ' Hz' : '—'}`);
  await sleep(400);
}

console.log(`\n完成 ${done} 条，失败 ${failed} 条。`);
console.log('下一步：node tools/campaign-test.mjs 校验，并检查各行基频是否落在角色区间内。');
