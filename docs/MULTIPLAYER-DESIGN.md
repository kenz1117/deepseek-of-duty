# LAN multiplayer design (Season 3)

## 1. Modes

### CO-OP SURVIVAL — shipping

| Field | Value |
| --- | --- |
| Players | **2–4 human** (host + up to 3) |
| Faction | All humans on **TASK FORCE**; AI on **INSURGENT** |
| AI soldiers | **4–14 per wave**, scaled by human count: `min(14, 3 + wave + 2 × (humans − 1))` (code: `src/main.js`, `min(14, …)` — the 16 here was never implemented) |
| AI on field | `min(12, 6 + 2 × (humans − 1))` alive at once |
| Fire budget | The open-fire budget is **per player**, not per match: each player can face the solo threat level (`maxFiring` bursts per 1.15 s). Versus keeps one shared pool on purpose. |
| Downed | 18 s bleed-out, revive with a 2 s hold, back up at **35 % HP** (was 30 s / 50 % — dying was almost free) |
| Objective | Shared survival waves; downed player redeploys after 4 s |
| Friendly fire | Off |
| Sync | Host-authoritative enemies/waves; 20 Hz snapshots |
| Human model | **Officer**: red beret, gold shoulder boards/collar tabs, chest badge, `★` nameplate |
| AI model | Generic rifleman/rusher/shield/sniper; no beret/insignia |

Scaling example:

| Humans | AI per wave | AI alive |
| --- | --- | --- |
| 1 (solo PvE) | 4–14 | 6 |
| 2 | 6–14 | 8 |
| 3 | 8–14 | 10 |
| 4 | 10–14 | 12 |

### VERSUS 4v4 — designed, locked

| Field | Value |
| --- | --- |
| Players | **2–8 human** (up to 4 per team) |
| Factions | **TASK FORCE vs INSURGENT** |
| AI fills | Each team is padded to **4 combatants** with AI bots; e.g. 2 humans + 2 bots per side |
| AI soldiers | Up to **8 bots** total (4 per team), fewer when more humans join |
| Objective | Team deathmatch, 50 kills or 6 minutes; friendly fire off |
| Human model | Officer (red beret / gold insignia); bots use the generic faction soldier |
| Status | **Not shipping** — UI marks it `NEXT`; no fake matchmaking |

Why it is locked: the current AI is a single-faction PvE director (perception/director/cover assume one player team). A credible 4v4 needs bot-vs-bot target selection, team spawn lanes, AI objective logic and its own balance pass. Shipping a broken versus mode would be worse than not shipping it.

## 2. Officer identity

Humans must be readable at a glance:

- red beret + gold band;
- gold shoulder boards and collar tabs;
- chest badge;
- `★ CALLSIGN` nameplate instead of a plain name;
- officer only for humans; AI never wears the beret/insignia.

## 3. Network model

- Host simulates enemies/waves and owns the authoritative HP/score.
- Clients move locally, send `input`; shooting sends `fire` with camera ray; host raycasts and returns hit/kill.
- Server is a relay only (`server/lan.mjs`): rooms, 4 players, host election, rate limit, 16 KB messages.
- No server authority, no anti-cheat, no persistence, no host migration of world state.

## 4. Deliberate omissions (co-op v1)

- client grenades are not replicated; enemy utilities are disabled in LAN because clients have no grenade-warning HUD yet;
- no ping/scoreboard UI beyond the lobby player list;
- no reconnect into a live run;
- no campaign co-op — only survival on the shared map.

## 5. Next steps for VERSUS

1. Generalize `Enemy` targeting to a `team` target list (humans + bots).
2. Add bot objective logic (push/cover/regroup) and team spawn zones.
3. Server/host scoreboard, respawn tickets, round timer.
4. Anti-cheat at least for fire rate and movement speed.
5. Separate balance pass for PvP (damage falloff, TTK, no aim assist).
