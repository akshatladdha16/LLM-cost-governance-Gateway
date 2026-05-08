const WINDOW_MS = 60000;

let rpmLimit = 10;
let tpmLimit = 20000;

const slidingWindow = [];
const reservations = new Map();

const bucket = {
  rpmTokens: rpmLimit,
  tpmTokens: tpmLimit,
  lastRefillTs: Date.now(),
};

function purge(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  while (slidingWindow.length > 0 && slidingWindow[0].timestamp <= cutoff) {
    const entry = slidingWindow.shift();
    if (entry) {
      reservations.delete(entry.id);
    }
  }
}

function refillBuckets(now = Date.now()) {
  const elapsedSec = (now - bucket.lastRefillTs) / 1000;
  if (elapsedSec <= 0) return;

  bucket.rpmTokens = Math.min(rpmLimit, bucket.rpmTokens + elapsedSec * (rpmLimit / 60));
  bucket.tpmTokens = Math.min(tpmLimit, bucket.tpmTokens + elapsedSec * (tpmLimit / 60));
  bucket.lastRefillTs = now;
}

function getWindowUsage() {
  const currentRPM = slidingWindow.length;
  const currentTPM = slidingWindow.reduce((sum, item) => sum + item.tokens, 0);
  return { currentRPM, currentTPM };
}

function getWindowWaitMs(now = Date.now()) {
  purge(now);
  if (slidingWindow.length === 0) return 0;
  const oldestAge = now - slidingWindow[0].timestamp;
  return Math.max(0, WINDOW_MS - oldestAge + 100);
}

function getBucketWaitMs(estimatedTokens) {
  const requestDeficit = Math.max(0, 1 - bucket.rpmTokens);
  const tokenDeficit = Math.max(0, estimatedTokens - bucket.tpmTokens);
  const rpmWait = requestDeficit > 0 ? (requestDeficit / (rpmLimit / 60)) * 1000 : 0;
  const tpmWait = tokenDeficit > 0 ? (tokenDeficit / (tpmLimit / 60)) * 1000 : 0;
  return Math.max(rpmWait, tpmWait);
}

function canSend(estimatedTokens, now = Date.now()) {
  purge(now);
  refillBuckets(now);

  const usage = getWindowUsage();
  if (usage.currentRPM >= rpmLimit) {
    return {
      allowed: false,
      reason: 'SLIDING_WINDOW_RPM',
      waitMs: getWindowWaitMs(now),
    };
  }
  if (usage.currentTPM + estimatedTokens > tpmLimit) {
    return {
      allowed: false,
      reason: 'SLIDING_WINDOW_TPM',
      waitMs: getWindowWaitMs(now),
    };
  }

  if (bucket.rpmTokens < 1) {
    return {
      allowed: false,
      reason: 'TOKEN_BUCKET_RPM',
      waitMs: Math.ceil(getBucketWaitMs(estimatedTokens) + 50),
    };
  }
  if (bucket.tpmTokens < estimatedTokens) {
    return {
      allowed: false,
      reason: 'TOKEN_BUCKET_TPM',
      waitMs: Math.ceil(getBucketWaitMs(estimatedTokens) + 50),
    };
  }

  return { allowed: true };
}

function record(id, tokens, now = Date.now()) {
  const entry = { id, tokens, timestamp: now };
  slidingWindow.push(entry);
  reservations.set(id, entry);
  bucket.rpmTokens = Math.max(0, bucket.rpmTokens - 1);
  bucket.tpmTokens = Math.max(0, bucket.tpmTokens - tokens);
}

function tryAcquire(id, estimatedTokens) {
  const now = Date.now();
  const check = canSend(estimatedTokens, now);
  if (!check.allowed) return check;
  record(id, estimatedTokens, now);
  return { allowed: true };
}

function unrecord(id) {
  const reservation = reservations.get(id);
  if (!reservation) return;

  const idx = slidingWindow.findIndex((item) => item.id === id);
  if (idx >= 0) {
    slidingWindow.splice(idx, 1);
  }
  reservations.delete(id);
  bucket.rpmTokens = Math.min(rpmLimit, bucket.rpmTokens + 1);
  bucket.tpmTokens = Math.min(tpmLimit, bucket.tpmTokens + reservation.tokens);
}

function updateLimits(nextRpm, nextTpm) {
  if (Number.isFinite(nextRpm) && nextRpm > 0) rpmLimit = Number(nextRpm);
  if (Number.isFinite(nextTpm) && nextTpm > 0) tpmLimit = Number(nextTpm);

  refillBuckets(Date.now());
  bucket.rpmTokens = Math.min(bucket.rpmTokens, rpmLimit);
  bucket.tpmTokens = Math.min(bucket.tpmTokens, tpmLimit);
}

function getUtilization() {
  purge(Date.now());
  const usage = getWindowUsage();
  return {
    currentRPM: usage.currentRPM,
    currentTPM: usage.currentTPM,
    rpmLimit,
    tpmLimit,
    bucket: {
      rpmTokens: Math.floor(bucket.rpmTokens * 100) / 100,
      tpmTokens: Math.floor(bucket.tpmTokens * 100) / 100,
    },
  };
}

module.exports = {
  canSend,
  tryAcquire,
  unrecord,
  updateLimits,
  getUtilization,
};
