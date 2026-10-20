# Season 3 — expansion brief (shared contract)

Three parallel tracks. This file is the source of truth for coordinates, APIs
and file ownership. Do not edit files outside your scope; do not commit.

## Track A — Map expansion (owner: world-artist)

Read `src/world/level.js` first. Keep the existing street/HQ/dock/yard intact.

New `level.bounds`:

```js
{ x0: -118, x1: 124, z0: -196, z1: 128 }
```

Three new districts, each with a distinct silhouette and gameplay:

| id | region name | rectangle (x, z) | stage spawn (must be open ground) | objective zone |
| --- | --- | --- | --- | --- |
| `old_souk` | 老城集市 | -116..-40, -42..72 | (-96, 46), yaw 0.6 | (-74, 12), r 6 |
| `rail_depot` | 北站货场 | -38..42, -194..-106 | (0, -180), yaw 0 | (4, -142), r 7 |
| `container_yard` | 东港集装箱场 | 48..122, -98..34 | (80, -80), yaw -1.2 | (98, -44), r 6 |

Connectivity (must be walkable, >= 6 m wide):

- souk ↔ existing west side: two gates around `x=-30..-38, z=18..30` and `x=-30..-38, z=-8..2`.
- rail ↔ existing north gate: opening at `x=0..12, z=-96..-108`.
- port ↔ existing east dock: opening at `x=46..50, z=-84..-76`.

District requirements:

- **old_souk**: 4–7 m alleys, two-storey shophouses, awnings, stalls, one
  courtyard with a minaret landmark; a few enterable ground-floor shops.
  Dense CQB, short sightlines.
- **rail_depot**: rail cut with an elevated platform at y≈4.2 (ramp/stair
  walkable, add `ROOF_ZONES` + `groundHeight` support), a 20×28 warehouse
  interior, container stacks; long lanes + one vertical power position.
- **container_yard**: container maze, 24×20 warehouse interior, a gantry crane
  landmark, water edge; mid-range lanes and flank routes. Must not duplicate
  the existing east dock.

Technical requirements:

- Use the existing helpers (`meshBox`, `addCollider*`, `mergeStatic`, existing
  materials/textures). Merge static geometry; budget **≤ +180 draw calls**.
- Every solid gets a collider with correct `top`; every visible surface that
  bullets should hit goes into `bulletTargets`.
- Add `spawnPoints` (ground + at least 2 roof/elevated), `coverPoints`,
  `objectiveZones` entries (`old_souk`, `rail_depot`, `container_yard`), and
  region names in `REGIONS`.
- Export `level.stages = { souk: {x,z,yaw}, rail: {...}, port: {...} }` and
  `level.districts` metadata for the campaign.
- Keep the whole map connected for the A* grid: verify with `nav.findPath`
  from each stage to `(1.2, 33)`.
- Update the minimap only through `level.colliders` (it already reads them);
  do not hard-code minimap ranges.
- `npm run build` must stay green; provide a screenshot of each new district
  (`?shot=1&pose=hero` cannot teleport — use the debug API with a small
  headless eval, or add temporary stage poses only if you remove them).

Acceptance:

- 3 new regions visible on the map, each ≥ 60×60 m of playable space.
- Path from each stage to the old street exists.
- No spawn/cover point inside geometry.
- Frame time on the existing `?shot=1` scene does not regress by more than 15%.

## Track B — LAN multiplayer (owner: net-lead)

Vertical slice: **2–4 player co-op survival on the existing map**. Host
authoritative for enemies/waves; client movement is local and trusted (LAN).

Files: `server/lan.mjs`, `src/net/lanProtocol.js`, `src/net/lanClient.js`,
`tools/lan-smoke.mjs`, `server/README.md`, `package.json` (script only).
Do not edit `src/main.js`.

Protocol (JSON, WebSocket, 20 Hz snapshots):

```
c→s join   { t:'join', room, name }
c→s input  { t:'input', seq, x, z, yaw, pitch, hp, alive }
c→s fire   { t:'fire', seq, ox,oy,oz, dx,dy,dz, weapon }
c→s event  { t:'event', kind, ... }        // respawn, ready
s→c welcome{ t:'welcome', id, host, room, players }
s→c lobby  { t:'lobby', players:[{id,name,ready,host}] }
s→c snap   { t:'snapshot', tick, players, enemies, wave, kills, objective }
s→c event  { t:'event', kind, ... }        // damage, kill, hit, respawn
```

Server (`server/lan.mjs`):

- `ws` package (already a devDependency), port `8790`, room via query.
- max 4 players, 16 KB message cap, 60 messages/s per client, heartbeat.
- First player is host; on disconnect, promote next and tell clients.
- Relay snapshots/events from host; relay inputs/fire/events from clients.
- No HTTP static serving (Vite handles the client); README explains:
  `npm run lan` then clients open the Vite URL with `?lan=ws://HOST:8790`.

Client (`src/net/lanClient.js`):

- `createLanClient({ url, room, name, onLobby, onSnapshot, onEvent, onStatus })`.
- `connect()`, `close()`, `sendInput()`, `sendFire()`, `sendEvent()`,
  `broadcastSnapshot()`, `broadcastEvent()`.
- Reconnect with backoff (3 tries), never throw into the game loop.
- `isHost`, `id`, `players` getters.

Smoke test `tools/lan-smoke.mjs`: starts the server on a random port, connects
two WS clients, asserts welcome/lobby/snapshot relay, exits non-zero on error.

Acceptance: two clients see each other in the lobby; host snapshot reaches the
client; client fire reaches host; server enforces room cap and rate limit.

## Track C — LAN lobby + HUD (owner: hud-designer)

Files: `index.html`, `src/style.css`, `src/ui/lanLobby.js`, `src/ui/minimap.js`.
Do not edit `src/main.js`, `src/world/level.js`, `src/story.js`.

- Add a LAN entry in the mode selector or a menu action (`LAN CO-OP`), opening a
  lobby overlay: server address, room code, callsign, HOST / JOIN buttons,
  player list with host/ready state, START (host only), LEAVE, status/error.
- Match the existing CoD-ish visual language; no external assets.
- Export `createLanLobby({ onHost, onJoin, onStart, onLeave })` and expose
  `setStatus`, `setPlayers`, `open`, `close`, `get open`.
- Minimap: keep working with the expanded world; add a small **zoom cycle**
  (42 m / 70 m) if it helps, persisted in localStorage. Do not break `update`.
- Ensure the OPS mission list scrolls cleanly with up to 14 operations.

Acceptance: lobby renders at 1600×900 and 1280×720; keyboard focus is sane;
`npm run build` green; screenshots `shots/lan-lobby.png`,
`shots/lan-lobby-join.png`.

## Track D — Campaign & integration (owner: lead)

- `src/story.js`: add OP11–OP14 on the new districts (souk / rail / port /
  finale), distinct modes/atmospheres, radio text, boss beat. Keep OP01–10.
- `src/main.js`: nav/bounds wiring, new stage starts, LAN mode wiring, remote
  player/enemy sync, enemy target selection across players.
- Docs, verification, final integration commit.

## Ground rules

- No git commits, no version bumps, no touching another track's files.
- Run `npm run build` before reporting; report exact files changed and tests.
- If a contract must change, message the Lead first.
