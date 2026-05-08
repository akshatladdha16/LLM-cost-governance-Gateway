const MAX_SAMPLES = 2000;

const metrics = {
  totalReceived: 0,
  totalProcessed: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalRetries: 0,
  totalDLQ: 0,
  totalRejected429: 0,
  leaked429s: 0,
  latencies: [],
  queueHistory: [],
  circuitEvents: [],
  throttleHistory: [],
};

function addBounded(array, entry) {
  array.push(entry);
  if (array.length > MAX_SAMPLES) {
    array.splice(0, array.length - MAX_SAMPLES);
  }
}

function recordLatency(priority, waitMs, processingMs, totalMs) {
  addBounded(metrics.latencies, {
    priority,
    waitMs,
    processingMs,
    totalMs,
  });
}

function recordQueueSample(depth) {
  addBounded(metrics.queueHistory, {
    timestamp: new Date().toISOString(),
    ...depth,
  });
}

function recordThrottleSample(utilization) {
  addBounded(metrics.throttleHistory, {
    timestamp: new Date().toISOString(),
    rpm: utilization.currentRPM,
    tpm: utilization.currentTPM,
    rpmLimit: utilization.rpmLimit,
    tpmLimit: utilization.tpmLimit,
    rpmPct: utilization.rpmLimit > 0
      ? Math.round((utilization.currentRPM / utilization.rpmLimit) * 100)
      : 0,
    tpmPct: utilization.tpmLimit > 0
      ? Math.round((utilization.currentTPM / utilization.tpmLimit) * 100)
      : 0,
    bucket: utilization.bucket,
  });
}

function recordCircuitTransition(event) {
  addBounded(metrics.circuitEvents, event);
}

function buildLatencyStats() {
  const output = {};
  for (const priority of ['HIGH', 'MEDIUM', 'LOW']) {
    const entries = metrics.latencies.filter((item) => item.priority === priority);
    if (entries.length === 0) continue;

    const waits = entries.map((item) => item.waitMs).sort((a, b) => a - b);
    output[priority] = {
      count: entries.length,
      avg_wait_ms: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
      p50_wait_ms: waits[Math.floor(waits.length * 0.5)] || 0,
      p95_wait_ms: waits[Math.floor(waits.length * 0.95)] || 0,
      max_wait_ms: waits[waits.length - 1] || 0,
    };
  }
  return output;
}

function getSnapshot(queue, throttle, circuitBreaker, dlq) {
  const depth = queue.getDepth();
  const throttleState = throttle.getUtilization();
  const cbState = circuitBreaker.getState();

  return {
    engine: 'llm-orchestration-engine-v1',
    status: cbState.state === 'OPEN' ? 'DEGRADED' : 'HEALTHY',
    timestamp: new Date().toISOString(),
    counters: {
      total_received: metrics.totalReceived,
      total_processed: metrics.totalProcessed,
      total_succeeded: metrics.totalSucceeded,
      total_failed: metrics.totalFailed,
      total_retries: metrics.totalRetries,
      total_dlq: metrics.totalDLQ,
      provider_429s_absorbed: metrics.totalRejected429,
      leaked_429s: metrics.leaked429s,
    },
    queue: {
      current_depth: depth,
      starvation_guard_threshold_ms: 30000,
      history: metrics.queueHistory.slice(-20),
    },
    throttle: {
      rpm_used: throttleState.currentRPM,
      rpm_limit: throttleState.rpmLimit,
      rpm_utilization_pct: throttleState.rpmLimit > 0
        ? Math.round((throttleState.currentRPM / throttleState.rpmLimit) * 100)
        : 0,
      tpm_used: throttleState.currentTPM,
      tpm_limit: throttleState.tpmLimit,
      tpm_utilization_pct: throttleState.tpmLimit > 0
        ? Math.round((throttleState.currentTPM / throttleState.tpmLimit) * 100)
        : 0,
      token_bucket: throttleState.bucket,
      history: metrics.throttleHistory.slice(-20),
    },
    circuit_breaker: {
      state: cbState.state,
      consecutive_failures: cbState.failures,
      opened_at: cbState.openedAt ? new Date(cbState.openedAt).toISOString() : null,
      cooldown_remaining_ms: cbState.cooldownRemainingMs,
      events: metrics.circuitEvents.slice(-20),
    },
    dead_letter_queue: {
      count: dlq.getCount(),
      entries: dlq.getAll().slice(-10),
    },
    latency_by_priority: buildLatencyStats(),
    algorithms: {
      rate_limiting: ['sliding_window_counter', 'token_bucket_hybrid'],
      backoff: ['full_jitter_exponential', 'decorrelated_jitter'],
      queue: 'priority_queue_3tier_with_starvation_guard',
    },
  };
}

module.exports = {
  metrics,
  recordLatency,
  recordQueueSample,
  recordThrottleSample,
  recordCircuitTransition,
  getSnapshot,
};
