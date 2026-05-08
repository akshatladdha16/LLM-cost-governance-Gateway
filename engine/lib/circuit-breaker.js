const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

const breaker = {
  state: STATE.CLOSED,
  failures: 0,
  lastFailure: null,
  openedAt: null,
  successCount: 0,
  probeInFlight: false,
};

const CONFIG = {
  FAILURE_THRESHOLD: 3,
  COOLDOWN_MS: 15000,
  HALF_OPEN_MAX_PROBES: 2,
};

const transitionListeners = [];

function emitTransition(from, to, reason) {
  for (const listener of transitionListeners) {
    try {
      listener({ timestamp: new Date().toISOString(), from, to, reason });
    } catch (_err) {
      // no-op
    }
  }
}

function transitionTo(nextState, reason) {
  if (breaker.state === nextState) return;
  const previous = breaker.state;
  breaker.state = nextState;
  emitTransition(previous, nextState, reason);
}

function onTransition(listener) {
  transitionListeners.push(listener);
}

function onSuccess() {
  if (breaker.state === STATE.HALF_OPEN) {
    breaker.successCount += 1;
    breaker.probeInFlight = false;
    if (breaker.successCount >= CONFIG.HALF_OPEN_MAX_PROBES) {
      transitionTo(STATE.CLOSED, 'half-open probes succeeded');
      breaker.failures = 0;
      breaker.successCount = 0;
      breaker.openedAt = null;
    }
    return;
  }

  breaker.failures = 0;
}

function onFailure(statusCode) {
  if (statusCode !== 503) return;

  breaker.lastFailure = Date.now();

  if (breaker.state === STATE.HALF_OPEN) {
    breaker.probeInFlight = false;
    breaker.successCount = 0;
    breaker.failures += 1;
    breaker.openedAt = Date.now();
    transitionTo(STATE.OPEN, 'half-open probe failed');
    return;
  }

  breaker.failures += 1;
  if (breaker.failures >= CONFIG.FAILURE_THRESHOLD) {
    breaker.openedAt = Date.now();
    transitionTo(STATE.OPEN, 'failure threshold reached');
  }
}

function getCooldownRemainingMs() {
  if (breaker.state !== STATE.OPEN || !breaker.openedAt) return 0;
  return Math.max(0, CONFIG.COOLDOWN_MS - (Date.now() - breaker.openedAt));
}

function canRequest() {
  if (breaker.state === STATE.CLOSED) return true;

  if (breaker.state === STATE.OPEN) {
    if (getCooldownRemainingMs() <= 0) {
      transitionTo(STATE.HALF_OPEN, 'cooldown elapsed');
      breaker.successCount = 0;
      breaker.probeInFlight = true;
      return true;
    }
    return false;
  }

  if (breaker.state === STATE.HALF_OPEN) {
    if (!breaker.probeInFlight) {
      breaker.probeInFlight = true;
      return true;
    }
    return false;
  }

  return false;
}

function getState() {
  return {
    state: breaker.state,
    failures: breaker.failures,
    lastFailure: breaker.lastFailure,
    openedAt: breaker.openedAt,
    successCount: breaker.successCount,
    probeInFlight: breaker.probeInFlight,
    cooldownRemainingMs: getCooldownRemainingMs(),
    config: { ...CONFIG },
  };
}

module.exports = {
  STATE,
  onTransition,
  onSuccess,
  onFailure,
  canRequest,
  getState,
  getCooldownRemainingMs,
};
