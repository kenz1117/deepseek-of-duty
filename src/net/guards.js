/* Pure, host-side LAN validation helpers. This remains a LAN trust model:
   these checks stop stale packets, ordinary desync and trivial abuse; they are
   not a substitute for a dedicated authoritative internet server. */

export function isNewerSequence(seq, previous = -1) {
  return Number.isSafeInteger(seq) && seq > previous;
}

export function isNewerSnapshot(tick, previous = -1) {
  return Number.isSafeInteger(tick) && tick > previous;
}

export function movementAllowance(elapsedS) {
  const elapsed = Number.isFinite(elapsedS) ? Math.max(0.05, Math.min(1.25, elapsedS)) : 0.05;
  // Sprint is 7 m/s. The margin covers acceleration, knife lunge and jitter.
  return Math.min(12, 0.75 + elapsed * 9);
}

export function validMovementPacket(msg, remote, nowS) {
  if (!msg || !remote || !isNewerSequence(msg.seq, remote.lastInputSeq ?? -1)) return false;
  if (![msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every((v) => Number.isFinite(Number(v)))) return false;
  if (Math.abs(Number(msg.x)) > 10000 || Math.abs(Number(msg.y)) > 1000 || Math.abs(Number(msg.z)) > 10000) return false;
  const epoch = Number.isSafeInteger(msg.moveEpoch) ? msg.moveEpoch : 0;
  const previousEpoch = remote.moveEpoch ?? 0;
  if (epoch < previousEpoch) return false;
  if (epoch > previousEpoch) return true; // explicit respawn/redeployment
  const elapsed = nowS - (remote.lastInputAt ?? nowS - 0.05);
  const distance = Math.hypot(Number(msg.x) - remote.x, Number(msg.z) - remote.z);
  if (distance > movementAllowance(elapsed)) return false;
  const vertical = Math.abs(Number(msg.y) - (remote.y || 0));
  return vertical <= Math.max(2.5, elapsed * 10);
}

export function validFirePacket(msg, remote, nowS, weapon) {
  if (!msg || !remote || !weapon || !remote.alive) return false;
  if (!isNewerSequence(msg.seq, remote.lastFireSeq ?? -1)) return false;
  if (![msg.ox, msg.oy, msg.oz, msg.dx, msg.dy, msg.dz].every((v) => Number.isFinite(Number(v)))) return false;
  const originError = Math.hypot(
    Number(msg.ox) - remote.x,
    Number(msg.oy) - ((remote.y || 0) + (weapon.melee ? 0 : 1.68)),
    Number(msg.oz) - remote.z
  );
  if (originError > (weapon.melee ? 1.75 : 2.5)) return false;
  const reportedRate = Math.max(1, Math.min(3, Number(msg.fireRate) || 1));
  const baseInterval = weapon.melee ? weapon.meleeCooldown : 60 / weapon.rpm;
  const minInterval = baseInterval / reportedRate * 0.65; // jitter tolerance
  return nowS - (remote.lastFireAt ?? -1e9) >= minInterval;
}
