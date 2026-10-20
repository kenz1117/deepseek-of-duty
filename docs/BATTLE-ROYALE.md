# LAN Battle Royale / 毒圈 — design and scope

User goal: use the expanded map (city + souk + rail + port) as a LAN
battle-royale arena, PUBG-Mobile style, with a shrinking safe zone.

## v1 scope (recommended, shippable)

- **2–8 human players**, one life each, last alive wins.
- No AI bots in v1. Current enemy AI is a single-team PvE director; credible
  bot-vs-bot needs team target selection, loot/rotation logic and its own
  balance pass. Adding bots later is a separate milestone.
- Host-authoritative match:
  - host owns zone phases, player HP/death, winner;
  - clients move locally and send `fire`; host validates hits on remote players.
- Spawns: distributed across the four districts (street / souk / rail / port),
  not all at the central street. No parachute/drop-ship in v1.
- Loot: reuse existing weapon pickups + ammo/armor crates; each spawn cluster
  gets 3–5 pickups. No inventory/attachments in v1.
- No respawn, no spectator camera in v1; dead players see a simple
  "ELIMINATED — spectating later" overlay, then the result screen.

## Safe zone

Phases (host clock, broadcast in snapshots):

| Phase | Wait | Shrink | Radius | Damage outside |
| --- | --- | --- | --- | --- |
| 1 | 60 s | 45 s | 85 m | 1 HP/s |
| 2 | 45 s | 40 s | 55 m | 2 HP/s |
| 3 | 40 s | 35 s | 30 m | 4 HP/s |
| 4 | 30 s | 30 s | 14 m | 7 HP/s |
| Final | — | — | 0 | 10 HP/s |

- Center moves toward a random point inside the current circle, clamped to
  playable bounds.
- Zone is host-authoritative; clients only render it.
- Gas damage applies outside the circle, not inside buildings; no gas mask.
- HUD: minimap circle + next-circle line, `ALIVE n/8`, phase timer, gas vignette.
- World: translucent cylinder/wall at the circle edge + green screen tint when
  outside; no volumetric gas in v1.

## Match flow

1. LAN lobby chooses **BATTLE ROYALE**; host starts.
2. All players spawn at distributed sites; 10 s grace.
3. Zone phases; last alive wins.
4. Result: placement, kills, damage; return to lobby/menu.

## Required engineering

- server: raise room cap to 8; lobby 8 slots; mode field.
- net: remote player hitboxes + host damage routing; snapshot zone/alive/phase;
  death/winner events; no respawn in BR.
- gameplay: disable waves/AI/equipment in BR; spawn/loot distribution; zone
  damage; placement/result.
- HUD: lobby mode card, zone minimap ring, alive/phase/timer, gas overlay,
  winner screen.
- map: current 242×324 m is enough for 8; sea/dock and west mountains are
  backdrop, not playable; if a larger playable ring is wanted, bounds/nav must
  be extended separately.

## Deliberate omissions (v1)

- no 100 players, no AI bots, no parachute, no vehicles, no inventory/attachments,
  no revive/teammate respawn, no anti-cheat, no reconnect into a live match,
  no ranked/persistence.

## Decision needed

**v1 = 2–8 humans only** (recommended, much smaller and testable), or must
include AI bots to fill the lobby? Bots roughly double the AI/net work.
