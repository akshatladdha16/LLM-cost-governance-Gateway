const express = require('express');
const { v4: uuidv4 } = require('uuid');

const queue = require('./lib/queue');
const throttle = require('./lib/throttle');
const circuitBreaker = require('./lib/circuit-breaker');
const backoff = require('./lib/backoff');
const dlq = require('./lib/dlq');
const tokenEstimator = require('./lib/token-estimator');
const providerClient = require('./lib/provider-client');
const metricsLib = require('./lib/metrics');

const app = express();
app.use(express.json());

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 29000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapPriority(header) {
  const val = String(header || '').toUpperCase();
  if (val === 'HIGH' || val === 'MEDIUM' || val === 'LOW') return val;
  return 'MEDIUM';
}

function addToDlqAndRespond(entry, statusCode, payload, reason) {
  if (entry.state === 'DONE') return;

  entry.state = 'DONE';
  if (entry.timeout) clearTimeout(entry.timeout);
  throttle.unrecord(entry.id);

  dlq.add({ ...entry, reason });
  metricsLib.metrics.totalDLQ += 1;
  metricsLib.metrics.totalProcessed += 1;
  metricsLib.metrics.totalFailed += 1;

  if (!entry.res.headersSent) {
    entry.res.status(statusCode).json(payload);
  }
}

app.post('/v1/chat/completions', (req, res) => {
  const cbState = circuitBreaker.getState();
  if (cbState.state === 'OPEN' && cbState.cooldownRemainingMs > 0) {
    const id = uuidv4();
    const priority = mapPriority(req.headers['x-priority']);
    const immediateEntry = {
      id,
      req,
      res,
      priority,
      enqueuedAt: Date.now(),
      attempts: 0,
      errors: [],
      state: 'DONE',
    };
    dlq.add({ ...immediateEntry, reason: 'Circuit breaker OPEN at ingress' });
    metricsLib.metrics.totalReceived += 1;
    metricsLib.metrics.totalDLQ += 1;
    metricsLib.metrics.totalProcessed += 1;
    metricsLib.metrics.totalFailed += 1;

    return res.status(503).json({
      error: {
        type: 'service_unavailable',
        message: 'Provider unavailable; request moved to DLQ.',
        dlq_id: id,
        circuit_breaker: 'OPEN',
      },
    });
  }

  const id = uuidv4();
  const priority = mapPriority(req.headers['x-priority']);
  const estimated = tokenEstimator.estimate(req.body.messages || [], req.body.max_tokens);

  metricsLib.metrics.totalReceived += 1;

  const entry = {
    id,
    req,
    res,
    priority,
    estimatedTokens: estimated.total,
    enqueuedAt: Date.now(),
    attempts: 0,
    errors: [],
    state: 'QUEUED',
    timeout: null,
  };

  entry.timeout = setTimeout(() => {
    if (entry.state === 'DONE') return;

    if (entry.state === 'QUEUED') {
      queue.remove(entry.id);
    }

    addToDlqAndRespond(
      entry,
      504,
      {
        error: {
          type: 'gateway_timeout',
          message: 'Request exceeded 29s. Moved to DLQ.',
          dlq_id: entry.id,
        },
      },
      'Timeout - exceeded 29s queue/processing time'
    );
  }, REQUEST_TIMEOUT_MS);

  queue.enqueue(entry);
});

app.get('/metrics', (_req, res) => {
  res.json(metricsLib.getSnapshot(queue, throttle, circuitBreaker, dlq));
});

app.get('/health', (_req, res) => {
  const cbState = circuitBreaker.getState();
  res.json({
    status: cbState.state === 'OPEN' ? 'degraded' : 'healthy',
    queue_depth: queue.getDepth().total,
    circuit_breaker: cbState.state,
  });
});

app.get('/dlq', (_req, res) => {
  res.json({ count: dlq.getCount(), entries: dlq.getAll() });
});

app.post('/dlq/replay/:id', (req, res) => {
  const id = req.params.id;
  const dlqEntry = dlq.removeById(id);
  if (!dlqEntry) {
    return res.status(404).json({ error: { type: 'not_found', message: 'DLQ entry not found' } });
  }

  const replayId = uuidv4();
  const replayEntry = {
    id: replayId,
    req: {
      body: {
        model: dlqEntry.originalRequest.model,
        messages: dlqEntry.originalRequest.messages,
        max_tokens: dlqEntry.originalRequest.max_tokens,
      },
      headers: {
        'x-priority': dlqEntry.originalRequest.priority || 'MEDIUM',
      },
    },
    res,
    priority: dlqEntry.originalRequest.priority || 'MEDIUM',
    estimatedTokens: tokenEstimator.estimate(
      dlqEntry.originalRequest.messages || [],
      dlqEntry.originalRequest.max_tokens
    ).total,
    enqueuedAt: Date.now(),
    attempts: 0,
    errors: [{ replayed_from_dlq_id: id, at: new Date().toISOString() }],
    state: 'QUEUED',
    timeout: null,
  };

  replayEntry.timeout = setTimeout(() => {
    if (replayEntry.state === 'DONE') return;
    if (replayEntry.state === 'QUEUED') queue.remove(replayEntry.id);
    addToDlqAndRespond(
      replayEntry,
      504,
      {
        error: {
          type: 'gateway_timeout',
          message: 'Replay exceeded 29s. Moved back to DLQ.',
          dlq_id: replayEntry.id,
        },
      },
      `Replay timed out (source DLQ id: ${id})`
    );
  }, REQUEST_TIMEOUT_MS);

  metricsLib.metrics.totalReceived += 1;
  queue.enqueue(replayEntry);
  return undefined;
});

async function waitForThrottleAcquire(entry) {
  while (entry.state !== 'DONE') {
    const acquired = throttle.tryAcquire(entry.id, entry.estimatedTokens);
    if (acquired.allowed) return true;
    await sleep(Math.min(Math.max(acquired.waitMs || 100, 100), 1000));
  }
  return false;
}

async function processRequest(entry) {
  if (entry.state === 'DONE') return;
  entry.state = 'PROCESSING';

  let previousDelay = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (entry.state === 'DONE') return;

    if (!circuitBreaker.canRequest()) {
      return addToDlqAndRespond(
        entry,
        503,
        {
          error: {
            type: 'provider_down',
            message: 'Provider unavailable. Request moved to DLQ.',
            dlq_id: entry.id,
            circuit_breaker: circuitBreaker.getState().state,
          },
        },
        'Circuit breaker OPEN during processing'
      );
    }

    const acquired = await waitForThrottleAcquire(entry);
    if (!acquired) return;

    try {
      const result = await providerClient.call({
        model: entry.req.body.model || 'mock-llm-provider-v1',
        messages: entry.req.body.messages || [],
        max_tokens: entry.req.body.max_tokens || 200,
      });

      if (entry.state === 'DONE') return;

      if (result.status === 200) {
        circuitBreaker.onSuccess();
        entry.state = 'DONE';
        clearTimeout(entry.timeout);

        const waitMs = Date.now() - entry.enqueuedAt;
        const processingMs = Number(result.headers['x-processing-time-ms']) || result.latency || 0;
        const totalMs = waitMs + processingMs;
        metricsLib.recordLatency(entry.priority, waitMs, processingMs, totalMs);
        metricsLib.metrics.totalSucceeded += 1;
        metricsLib.metrics.totalProcessed += 1;

        if (!entry.res.headersSent) {
          result.body._gateway = {
            queue_wait_ms: waitMs,
            priority: entry.priority,
            attempts: attempt + 1,
            engine: 'llm-orchestration-engine-v1',
          };
          entry.res.status(200).json(result.body);
        }
        return;
      }

      if (result.status === 429) {
        metricsLib.metrics.totalRejected429 += 1;
        throttle.unrecord(entry.id);

        if (attempt < MAX_RETRIES) {
          const delay = backoff.fullJitter(attempt);
          metricsLib.metrics.totalRetries += 1;
          entry.attempts = attempt + 1;
          entry.errors.push({
            attempt,
            status: 429,
            at: new Date().toISOString(),
            retryInMs: delay,
          });
          await sleep(delay);
          continue;
        }

        return addToDlqAndRespond(
          entry,
          503,
          {
            error: {
              type: 'retries_exhausted',
              message: 'Request failed after max retries.',
              dlq_id: entry.id,
            },
          },
          'Max retries exhausted on provider 429'
        );
      }

      if (result.status === 503) {
        circuitBreaker.onFailure(503);
        throttle.unrecord(entry.id);

        if (attempt < MAX_RETRIES) {
          const delay = backoff.decorrelated(previousDelay);
          previousDelay = delay;
          metricsLib.metrics.totalRetries += 1;
          entry.attempts = attempt + 1;
          entry.errors.push({
            attempt,
            status: 503,
            at: new Date().toISOString(),
            retryInMs: delay,
          });
          await sleep(delay);
          continue;
        }

        return addToDlqAndRespond(
          entry,
          503,
          {
            error: {
              type: 'provider_down',
              message: 'Provider is down. Request moved to DLQ.',
              dlq_id: entry.id,
              circuit_breaker: circuitBreaker.getState().state,
            },
          },
          'Provider unavailable (503)'
        );
      }

      throttle.unrecord(entry.id);
      return addToDlqAndRespond(
        entry,
        502,
        {
          error: {
            type: 'bad_gateway',
            message: `Provider returned status ${result.status}`,
            dlq_id: entry.id,
          },
        },
        `Unexpected provider status ${result.status}`
      );
    } catch (err) {
      circuitBreaker.onFailure(503);
      throttle.unrecord(entry.id);

      if (attempt < MAX_RETRIES) {
        const delay = backoff.fullJitter(attempt);
        metricsLib.metrics.totalRetries += 1;
        entry.attempts = attempt + 1;
        entry.errors.push({
          attempt,
          error: err.message,
          at: new Date().toISOString(),
          retryInMs: delay,
        });
        await sleep(delay);
        continue;
      }

      return addToDlqAndRespond(
        entry,
        503,
        {
          error: {
            type: 'network_error',
            message: err.message,
            dlq_id: entry.id,
          },
        },
        `Network error: ${err.message}`
      );
    }
  }
}

async function drainLoop() {
  while (true) {
    const next = queue.peek();
    if (!next) {
      await sleep(50);
      continue;
    }

    const item = queue.dequeue();
    if (!item) {
      await sleep(20);
      continue;
    }

    processRequest(item).catch((err) => {
      if (item.state !== 'DONE') {
        addToDlqAndRespond(
          item,
          503,
          {
            error: {
              type: 'internal_error',
              message: err.message,
              dlq_id: item.id,
            },
          },
          `Unhandled processing exception: ${err.message}`
        );
      }
    });
  }
}

async function adaptiveLimitPoller() {
  while (true) {
    try {
      const data = await providerClient.getMetrics();
      if (data && data.config) {
        throttle.updateLimits(data.config.rpm_limit, data.config.tpm_limit);
      }
    } catch (_err) {
      // Provider might be down.
    }
    await sleep(5000);
  }
}

setInterval(() => {
  metricsLib.recordQueueSample(queue.getDepth());
  metricsLib.recordThrottleSample(throttle.getUtilization());
}, 1000);

circuitBreaker.onTransition((event) => {
  metricsLib.recordCircuitTransition(event);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`
============================================================
LLM ORCHESTRATION ENGINE READY
============================================================
Engine    -> http://localhost:${PORT}
Provider  -> ${process.env.LLM_PROVIDER_URL || 'http://localhost:3999'}
Metrics   -> http://localhost:${PORT}/metrics
DLQ       -> http://localhost:${PORT}/dlq
Health    -> http://localhost:${PORT}/health
============================================================
Queue     -> HIGH/MEDIUM/LOW with starvation guard
Throttle  -> Sliding window + token bucket hybrid
Backoff   -> Full jitter + decorrelated jitter
Circuit   -> CLOSED -> OPEN -> HALF_OPEN
============================================================
  `);

  drainLoop().catch((err) => {
    console.error('drainLoop crashed:', err);
  });

  adaptiveLimitPoller().catch(() => {});
});
