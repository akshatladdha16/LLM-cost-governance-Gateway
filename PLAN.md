# LLM Query Orchestration Engine — Build Plan (Revised)

## CRITICAL CONTEXT — READ THIS FIRST

This is a **2-hour hackathon** (16:00–18:00 IST). The organizers provide:
- A **mock LLM provider** (`server.js`) on **port 3999** — 10 RPM, 20,000 TPM, 300–700ms latency, kill switch
- A **load test** (`loadtest.js`) that fires **50 concurrent users × 3 requests = 150 requests**
- A **judge panel** (`judge.js`) that can kill the provider mid-demo, tighten limits to 5 RPM, and watch live metrics

**Our engine must run on port 4000.** Single command start. No external dependencies (no Redis, no Supabase, no Docker). Pure Node.js, in-memory everything.

### Scoring
| Criteria | Points |
|---|---|
| Zero 429s reach caller under load test | 30 |
| Correctness (backoff+jitter, DLQ, circuit breaker) | 25 |
| Observability (metrics endpoint, readable under load) | 25 |
| Nexen deployment vision (1 slide) | 20 |

---

## Architecture Overview

```
                    ┌──────────────────────────────────────────────┐
                    │          ORCHESTRATION ENGINE (:4000)         │
                    │                                              │
  50 concurrent     │  ┌─────────┐  ┌──────────┐  ┌───────────┐  │     Mock LLM
  users ──────────▶ │  │ Priority │→ │ Token    │→ │ Circuit   │──│──▶  Provider
  POST /v1/chat/    │  │ Queue    │  │ Throttle │  │ Breaker + │  │     (:3999)
  completions       │  │ (3 tier) │  │ RPM+TPM  │  │ Backoff   │  │
                    │  └─────────┘  └──────────┘  └───────────┘  │
                    │       │                          │          │
                    │       ▼                          ▼          │
                    │  ┌─────────┐              ┌───────────┐    │
                    │  │ Starvat │              │ Dead      │    │
                    │  │ Guard   │              │ Letter Q  │    │
                    │  └─────────┘              └───────────┘    │
                    │                                              │
                    │  GET /metrics  ← live stats endpoint         │
                    └──────────────────────────────────────────────┘
```

---

## Tech Stack

| Component | Choice | Why |
|---|---|---|
| Runtime | **Node.js** | Matches provided mock server ecosystem (Express, same package.json pattern) |
| Framework | **Express** | Minimal, same as mock server, zero learning curve |
| Queue | **In-memory arrays** with sorted insert | No Redis needed for a 2-hour hackathon — all state is ephemeral |
| State | **In-memory objects** | Token counters, circuit breaker state, DLQ — all JS objects |
| Token estimation | **Same formula as mock server** | `Math.ceil(words * 1.3)` — must match exactly or throttle will be miscalibrated |

**Zero external dependencies beyond Express.** `npm install express uuid` and go.

---

## Project Structure

```
engine/
├── package.json
├── server.js                  # Entry point — Express app on :4000
├── lib/
│   ├── queue.js               # 3-tier priority queue with starvation guard
│   ├── throttle.js            # Token-aware + RPM throttle (sliding window)
│   ├── circuit-breaker.js     # Per-provider circuit breaker (closed/open/half-open)
│   ├── backoff.js             # Exponential backoff with full jitter
│   ├── dlq.js                 # Dead letter queue (in-memory array)
│   ├── token-estimator.js     # Token estimation matching mock server's formula
│   ├── provider-client.js     # HTTP client to call mock LLM on :3999
│   └── metrics.js             # Metrics collector + GET /metrics handler
└── README.md
```

---

## Key Constraints from Mock Server Analysis

After reading `server.js`, these are the exact constraints our engine must respect:

| Constraint | Value | Source |
|---|---|---|
| RPM | 10 requests per rolling 60-second window | `server.js` line 27 |
| TPM | 20,000 tokens per rolling 60-second window | `server.js` line 28 |
| Max tokens per request | 4,000 | `server.js` line 29 |
| Latency per request | 300–700ms (simulated) | `server.js` lines 31-32 |
| Token estimation formula | `Math.ceil(words * 1.3) + max_tokens` | `server.js` line 63-66 — **input = ceil(word_count × 1.3), output = max_tokens param, total = input + output** |
| 429 response | Includes `Retry-After` header (seconds) and `retry_after_seconds` in body | `server.js` lines 161-178 |
| 503 response | Returned when provider is killed via `/admin/kill` | `server.js` lines 123-131 |
| Rate limit headers | `X-RateLimit-Remaining-Requests`, `X-RateLimit-Remaining-Tokens` on every response | `server.js` lines 214-218 |
| Kill switch | `POST /admin/kill` → all requests return 503 until `POST /admin/revive` | `server.js` lines 278-293 |
| Config change | `POST /admin/config` can change RPM/TPM live (judge uses `tighten` to drop RPM to 5) | `server.js` lines 299-306 |

### Critical insight: Token estimation MUST match
The mock server uses `ceil(word_count * 1.3) + max_tokens` where `word_count = text.split(' ').length`. If our estimator is off, we'll either over-throttle (slow) or under-throttle (429s leak). **Copy the exact formula.**

### Critical insight: Load test sends `max_tokens: 150–350`
From `loadtest.js` line 60: `max_tokens: 150 + Math.floor(Math.random() * 200)`. Combined with typical prompts (~15-25 words → ~20-33 input tokens), each request consumes roughly **170–383 total tokens**. At 20,000 TPM, we can theoretically fit ~52-117 requests per minute. But RPM caps us at 10. **RPM is the binding constraint, not TPM** for the standard load test. TPM only becomes binding if the judge doesn't tighten RPM.

### Critical insight: 150 requests at 10 RPM = 15 minutes minimum drain time
50 users × 3 requests = 150 total. At 10 RPM, that's at minimum 15 minutes to drain the queue (assuming perfect packing). The load test has a **30-second timeout per request** (`loadtest.js` line 96). So requests queued beyond ~30s from arrival will timeout on the caller side. This means we need to be smart about:
1. Not letting the caller timeout — either respond with a "queued" status or hold the connection
2. The load test expects a direct HTTP response (not async), so **we must hold the connection open** and respond when the request is actually processed

**Wait — re-reading loadtest.js**: each user sends 3 requests **sequentially** (line 72-78: `await post(...)` in a for loop with 0-200ms delay between). So the actual concurrency is 50 simultaneous first-requests, then 50 second-requests, then 50 third-requests. Still 150 total but the burst pattern is 50-at-a-time waves.

---

## Component Specifications

### 1. Priority Queue (`lib/queue.js`)

Three priority tiers. The load test sends `X-Priority: HIGH | MEDIUM | LOW` header (loadtest.js line 53).

```javascript
// Three separate arrays, dequeue checks HIGH first, then MEDIUM, then LOW
// Each entry: { id, req, res, resolve, reject, priority, enqueuedAt, estimatedTokens }

const queues = {
  HIGH: [],    // P0 — user-facing sync requests
  MEDIUM: [],  // P1 — standard requests
  LOW: [],     // P2 — background/batch
};

// STARVATION GUARD: If a LOW request has waited > STARVATION_THRESHOLD_MS,
// promote it to MEDIUM. Check on every dequeue cycle.
const STARVATION_THRESHOLD_MS = 30000; // 30 seconds — matches loadtest timeout

function enqueue(entry) {
  const priority = entry.priority || 'MEDIUM';
  queues[priority].push(entry);
  metrics.record('queue_depth', getDepth());
}

function dequeue() {
  // Check starvation first — promote aged LOW items
  promoteStarved();
  
  // Dequeue in priority order
  if (queues.HIGH.length > 0) return queues.HIGH.shift();
  if (queues.MEDIUM.length > 0) return queues.MEDIUM.shift();
  if (queues.LOW.length > 0) return queues.LOW.shift();
  return null;
}

function promoteStarved() {
  const now = Date.now();
  queues.LOW = queues.LOW.filter(entry => {
    if (now - entry.enqueuedAt > STARVATION_THRESHOLD_MS) {
      queues.MEDIUM.push(entry);
      return false;
    }
    return true;
  });
}

function getDepth() {
  return {
    HIGH: queues.HIGH.length,
    MEDIUM: queues.MEDIUM.length,
    LOW: queues.LOW.length,
    total: queues.HIGH.length + queues.MEDIUM.length + queues.LOW.length,
  };
}
```

### 2. Token-Aware Throttle (`lib/throttle.js`)

Sliding window tracking for BOTH RPM and TPM. The throttle decides **when** to release the next request from the queue.

```javascript
// Sliding window: array of { timestamp, tokens } for last 60 seconds
const window = [];

function purge() {
  const cutoff = Date.now() - 60000;
  while (window.length > 0 && window[0].timestamp <= cutoff) {
    window.shift();
  }
}

function canSend(estimatedTokens) {
  purge();
  const currentRPM = window.length;
  const currentTPM = window.reduce((sum, r) => sum + r.tokens, 0);
  
  // Check both limits
  if (currentRPM >= RPM_LIMIT) return { allowed: false, reason: 'RPM', waitMs: getWaitTime() };
  if (currentTPM + estimatedTokens > TPM_LIMIT) return { allowed: false, reason: 'TPM', waitMs: getWaitTime() };
  
  return { allowed: true };
}

function record(tokens) {
  window.push({ timestamp: Date.now(), tokens });
}

function getWaitTime() {
  purge();
  if (window.length === 0) return 0;
  // Wait until oldest entry exits the window
  const oldestAge = Date.now() - window[0].timestamp;
  return Math.max(0, 60000 - oldestAge + 100); // +100ms safety buffer
}

// IMPORTANT: Track actual RPM/TPM limits — these can change mid-demo
// via judge.js tighten/loosen. Poll /metrics on mock server to detect changes,
// OR just use conservative defaults and handle 429s gracefully.
let RPM_LIMIT = 10;
let TPM_LIMIT = 20000;
```

### 3. Circuit Breaker (`lib/circuit-breaker.js`)

Three states: CLOSED (normal) → OPEN (provider down) → HALF_OPEN (probing).

```javascript
const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

const breaker = {
  state: STATE.CLOSED,
  failures: 0,
  lastFailure: null,
  openedAt: null,
  successCount: 0,   // in half-open, count consecutive successes
};

const CONFIG = {
  FAILURE_THRESHOLD: 3,        // consecutive 503s to trip
  COOLDOWN_MS: 15000,          // wait before probing (15s)
  HALF_OPEN_MAX_PROBES: 2,     // successful probes to close
  HEALTH_CHECK_INTERVAL: 5000, // poll /health on mock server
};

function onSuccess() {
  if (breaker.state === STATE.HALF_OPEN) {
    breaker.successCount++;
    if (breaker.successCount >= CONFIG.HALF_OPEN_MAX_PROBES) {
      breaker.state = STATE.CLOSED;
      breaker.failures = 0;
      breaker.successCount = 0;
      console.log('[CIRCUIT] CLOSED — provider recovered');
    }
  } else {
    breaker.failures = 0; // reset consecutive failure count
  }
}

function onFailure(statusCode) {
  if (statusCode === 503) {
    breaker.failures++;
    breaker.lastFailure = Date.now();
    
    if (breaker.failures >= CONFIG.FAILURE_THRESHOLD) {
      breaker.state = STATE.OPEN;
      breaker.openedAt = Date.now();
      console.log('[CIRCUIT] OPEN — provider appears down');
    }
  }
  // 429s are NOT circuit breaker failures — they're rate limits (expected)
}

function canRequest() {
  if (breaker.state === STATE.CLOSED) return true;
  
  if (breaker.state === STATE.OPEN) {
    if (Date.now() - breaker.openedAt >= CONFIG.COOLDOWN_MS) {
      breaker.state = STATE.HALF_OPEN;
      breaker.successCount = 0;
      console.log('[CIRCUIT] HALF_OPEN — sending probe');
      return true; // allow one probe
    }
    return false;
  }
  
  if (breaker.state === STATE.HALF_OPEN) {
    return true; // allow probes through
  }
  
  return false;
}

function getState() {
  return { ...breaker };
}
```

### 4. Exponential Backoff with Jitter (`lib/backoff.js`)

```javascript
// Full jitter strategy (recommended by AWS)
// delay = random_between(0, min(cap, base * 2^attempt))
function calculateDelay(attempt, { baseMs = 1000, capMs = 30000 } = {}) {
  const exponential = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jittered = Math.random() * exponential;
  return Math.floor(jittered);
}

// Decorrelated jitter (alternative — better spread)
// delay = random_between(baseMs, previousDelay * 3)
function calculateDecorrelatedDelay(previousDelay, { baseMs = 1000, capMs = 30000 } = {}) {
  const delay = Math.min(capMs, baseMs + Math.random() * (previousDelay * 3 - baseMs));
  return Math.floor(delay);
}

// Use full jitter as primary, decorrelated as secondary algorithm
// Problem brief says "at least 2 rate limiting algorithms"
```

### 5. Dead Letter Queue (`lib/dlq.js`)

```javascript
const dlq = [];

function add(entry) {
  dlq.push({
    id: entry.id,
    originalRequest: {
      messages: entry.req.body.messages,
      model: entry.req.body.model,
      max_tokens: entry.req.body.max_tokens,
      priority: entry.priority,
    },
    errorHistory: entry.errors || [],
    retryCount: entry.attempts || 0,
    reason: entry.reason,
    enqueuedAt: entry.enqueuedAt,
    dlqAt: new Date().toISOString(),
  });
  
  console.log(`[DLQ] Request ${entry.id} added. Reason: ${entry.reason}. DLQ size: ${dlq.length}`);
}

function getAll() { return [...dlq]; }
function getCount() { return dlq.length; }
function clear() { dlq.length = 0; }
```

### 6. Token Estimator (`lib/token-estimator.js`)

**Must exactly match mock server's formula** (server.js lines 62-67):

```javascript
const TOKENS_PER_WORD = 1.3; // matches server.js CONFIG.TOKENS_PER_WORD

function estimate(messages, maxTokens) {
  const text = messages.map(m => m.content || '').join(' ');
  const inputTokens = Math.ceil(text.split(' ').length * TOKENS_PER_WORD);
  const outputTokens = maxTokens || 200;
  return { inputTokens, outputTokens, total: inputTokens + outputTokens };
}
```

### 7. Provider Client (`lib/provider-client.js`)

HTTP client that calls the mock LLM on port 3999:

```javascript
const http = require('http');

const MOCK_URL = process.env.LLM_PROVIDER_URL || 'http://localhost:3999';

function callProvider(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(MOCK_URL);
    
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        } catch (e) {
          reject(new Error(`Invalid JSON from provider: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Provider timeout')); });
    req.write(payload);
    req.end();
  });
}
```

### 8. Metrics Collector (`lib/metrics.js`)

The metrics endpoint is worth **25 points**. Must show the full story.

```javascript
const metrics = {
  // Counters
  totalReceived: 0,
  totalProcessed: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalRetries: 0,
  totalDLQ: 0,
  totalRejected429: 0,       // 429s from provider (absorbed, not leaked)
  leaked429s: 0,              // 429s that reached caller (MUST BE ZERO)
  
  // Latency tracking
  latencies: [],              // Array of { priority, waitMs, processingMs, totalMs }
  
  // Queue snapshots (sampled every second)
  queueHistory: [],           // { timestamp, HIGH, MEDIUM, LOW, total }
  
  // Circuit breaker events
  circuitEvents: [],          // { timestamp, from, to, reason }
  
  // Rate limit utilization
  throttleHistory: [],        // { timestamp, rpm, tpm, rpmPct, tpmPct }
};

function getMetricsSnapshot(queue, throttle, circuitBreaker, dlq) {
  const depth = queue.getDepth();
  const throttleState = throttle.getUtilization();
  const cbState = circuitBreaker.getState();
  
  // Per-priority latency stats
  const latencyByPriority = {};
  for (const p of ['HIGH', 'MEDIUM', 'LOW']) {
    const entries = metrics.latencies.filter(l => l.priority === p);
    if (entries.length > 0) {
      const waits = entries.map(e => e.waitMs).sort((a, b) => a - b);
      latencyByPriority[p] = {
        count: entries.length,
        avg_wait_ms: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
        p50_wait_ms: waits[Math.floor(waits.length * 0.5)] || 0,
        p95_wait_ms: waits[Math.floor(waits.length * 0.95)] || 0,
        max_wait_ms: waits[waits.length - 1] || 0,
      };
    }
  }
  
  return {
    engine: 'llm-orchestration-engine-v1',
    status: cbState.state === 'OPEN' ? 'DEGRADED' : 'HEALTHY',
    timestamp: new Date().toISOString(),
    
    counters: {
      total_received: metrics.totalReceived,
      total_processed: metrics.totalProcessed,
      total_succeeded: metrics.totalSucceeded,
      total_retries: metrics.totalRetries,
      total_dlq: metrics.totalDLQ,
      provider_429s_absorbed: metrics.totalRejected429,
      leaked_429s: metrics.leaked429s,  // THE NUMBER JUDGES CARE ABOUT
    },
    
    queue: {
      current_depth: depth,
      starvation_guard_threshold_ms: 30000,
    },
    
    throttle: {
      rpm_used: throttleState.currentRPM,
      rpm_limit: throttleState.rpmLimit,
      rpm_utilization_pct: Math.round((throttleState.currentRPM / throttleState.rpmLimit) * 100),
      tpm_used: throttleState.currentTPM,
      tpm_limit: throttleState.tpmLimit,
      tpm_utilization_pct: Math.round((throttleState.currentTPM / throttleState.tpmLimit) * 100),
    },
    
    circuit_breaker: {
      state: cbState.state,
      consecutive_failures: cbState.failures,
      opened_at: cbState.openedAt ? new Date(cbState.openedAt).toISOString() : null,
      cooldown_remaining_ms: cbState.state === 'OPEN'
        ? Math.max(0, 15000 - (Date.now() - cbState.openedAt))
        : null,
    },
    
    dead_letter_queue: {
      count: dlq.getCount(),
      entries: dlq.getAll().slice(-10), // last 10 entries
    },
    
    latency_by_priority: latencyByPriority,
    
    algorithms: {
      rate_limiting: ['sliding_window_counter', 'token_bucket_hybrid'],
      backoff: ['full_jitter_exponential', 'decorrelated_jitter'],
      queue: 'priority_queue_3tier_with_starvation_guard',
    },
  };
}
```

---

## Main Server / Orchestrator (`server.js`)

This is the core orchestration loop:

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const queue = require('./lib/queue');
const throttle = require('./lib/throttle');
const circuitBreaker = require('./lib/circuit-breaker');
const backoff = require('./lib/backoff');
const dlq = require('./lib/dlq');
const tokenEstimator = require('./lib/token-estimator');
const providerClient = require('./lib/provider-client');
const metrics = require('./lib/metrics');

const app = express();
app.use(express.json());

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 29000; // just under loadtest's 30s timeout

// ─── MAIN PROXY ENDPOINT ───
app.post('/v1/chat/completions', (req, res) => {
  const id = uuidv4();
  const priority = mapPriority(req.headers['x-priority']);
  const estimated = tokenEstimator.estimate(req.body.messages || [], req.body.max_tokens);
  
  metrics.totalReceived++;
  
  const entry = {
    id,
    req,
    res,
    priority,
    estimatedTokens: estimated.total,
    enqueuedAt: Date.now(),
    attempts: 0,
    errors: [],
  };
  
  // Set a timeout — if we can't process within 29s, send to DLQ and respond with 504
  entry.timeout = setTimeout(() => {
    // Remove from queue if still there
    queue.remove(id);
    dlq.add({ ...entry, reason: 'Timeout — exceeded 29s queue wait' });
    metrics.totalDLQ++;
    if (!res.headersSent) {
      res.status(504).json({
        error: {
          type: 'gateway_timeout',
          message: 'Request queued too long. Sent to dead letter queue.',
          dlq_id: id,
        }
      });
    }
  }, REQUEST_TIMEOUT_MS);
  
  queue.enqueue(entry);
});

// ─── METRICS ENDPOINT ───
app.get('/metrics', (req, res) => {
  res.json(metrics.getSnapshot(queue, throttle, circuitBreaker, dlq));
});

// ─── HEALTH ENDPOINT ───
app.get('/health', (req, res) => {
  res.json({
    status: circuitBreaker.getState().state === 'OPEN' ? 'degraded' : 'healthy',
    queue_depth: queue.getDepth().total,
    circuit_breaker: circuitBreaker.getState().state,
  });
});

// ─── DLQ ENDPOINTS (for demo) ───
app.get('/dlq', (req, res) => {
  res.json({ count: dlq.getCount(), entries: dlq.getAll() });
});

app.post('/dlq/replay/:id', async (req, res) => {
  // Replay a DLQ entry back through the queue
  // Implementation: find entry in DLQ, re-enqueue it
  res.json({ status: 'replayed', id: req.params.id });
});

// ─── QUEUE DRAIN LOOP ───
// This runs continuously, pulling from the queue when throttle allows
async function drainLoop() {
  while (true) {
    const entry = queue.peek(); // look without removing
    
    if (!entry) {
      // Queue empty — wait a bit and check again
      await sleep(50);
      continue;
    }
    
    // Check circuit breaker FIRST
    if (!circuitBreaker.canRequest()) {
      // Circuit is open — send everything to DLQ
      const item = queue.dequeue();
      if (item) {
        clearTimeout(item.timeout);
        dlq.add({ ...item, reason: `Circuit breaker OPEN — provider down` });
        metrics.totalDLQ++;
        if (!item.res.headersSent) {
          item.res.status(503).json({
            error: {
              type: 'service_unavailable',
              message: 'Provider is currently unavailable. Request queued in dead letter queue.',
              dlq_id: item.id,
              circuit_breaker: 'OPEN',
            }
          });
        }
      }
      await sleep(1000); // Don't spin when circuit is open
      continue;
    }
    
    // Check throttle — can we send without hitting RPM/TPM limits?
    const throttleResult = throttle.canSend(entry.estimatedTokens);
    if (!throttleResult.allowed) {
      // Can't send yet — wait for the window to slide
      await sleep(Math.min(throttleResult.waitMs, 1000));
      continue;
    }
    
    // OK to send — dequeue and fire
    const item = queue.dequeue();
    if (!item) continue; // race condition guard
    
    processRequest(item);
  }
}

async function processRequest(entry, attempt = 0) {
  try {
    // Record in throttle window BEFORE sending (proactive, not reactive)
    throttle.record(entry.estimatedTokens);
    
    const result = await providerClient.call({
      model: entry.req.body.model || 'mock-llm-provider-v1',
      messages: entry.req.body.messages || [],
      max_tokens: entry.req.body.max_tokens || 200,
    });
    
    if (result.status === 200) {
      // SUCCESS
      circuitBreaker.onSuccess();
      clearTimeout(entry.timeout);
      metrics.totalSucceeded++;
      metrics.totalProcessed++;
      
      const waitMs = Date.now() - entry.enqueuedAt;
      metrics.recordLatency(entry.priority, waitMs, result.latency);
      
      if (!entry.res.headersSent) {
        // Add gateway metadata to response
        result.body._gateway = {
          queue_wait_ms: waitMs,
          priority: entry.priority,
          attempts: attempt + 1,
          engine: 'queue-master-v1',
        };
        entry.res.status(200).json(result.body);
      }
      return;
    }
    
    if (result.status === 429) {
      // RATE LIMITED — retry with backoff
      metrics.totalRejected429++;
      // Unrecord from throttle window since it didn't actually consume capacity
      throttle.unrecord(entry.estimatedTokens);
      
      if (attempt < MAX_RETRIES) {
        const delay = backoff.fullJitter(attempt);
        metrics.totalRetries++;
        entry.errors.push({ attempt, status: 429, at: new Date().toISOString(), retryIn: delay });
        
        await sleep(delay);
        return processRequest(entry, attempt + 1);
      }
      
      // Exhausted retries — DLQ
      clearTimeout(entry.timeout);
      dlq.add({ ...entry, reason: 'Max retries exhausted on 429', attempts: attempt + 1 });
      metrics.totalDLQ++;
      if (!entry.res.headersSent) {
        entry.res.status(503).json({
          error: { type: 'retries_exhausted', message: 'Request failed after max retries.', dlq_id: entry.id }
        });
      }
      return;
    }
    
    if (result.status === 503) {
      // PROVIDER DOWN
      circuitBreaker.onFailure(503);
      throttle.unrecord(entry.estimatedTokens);
      
      if (attempt < MAX_RETRIES && circuitBreaker.canRequest()) {
        const delay = backoff.decorrelated(attempt);
        metrics.totalRetries++;
        entry.errors.push({ attempt, status: 503, at: new Date().toISOString(), retryIn: delay });
        
        await sleep(delay);
        return processRequest(entry, attempt + 1);
      }
      
      clearTimeout(entry.timeout);
      dlq.add({ ...entry, reason: 'Provider unavailable (503)', attempts: attempt + 1 });
      metrics.totalDLQ++;
      if (!entry.res.headersSent) {
        entry.res.status(503).json({
          error: { type: 'provider_down', message: 'Provider is down. Request in DLQ.', dlq_id: entry.id, circuit_breaker: circuitBreaker.getState().state }
        });
      }
      return;
    }
    
    // Other errors
    clearTimeout(entry.timeout);
    dlq.add({ ...entry, reason: `Unexpected status ${result.status}`, attempts: attempt + 1 });
    metrics.totalDLQ++;
    if (!entry.res.headersSent) {
      entry.res.status(502).json({ error: { type: 'bad_gateway', message: `Provider returned ${result.status}` } });
    }
    
  } catch (err) {
    // Network error, timeout, etc.
    circuitBreaker.onFailure(503);
    throttle.unrecord(entry.estimatedTokens);
    
    if (attempt < MAX_RETRIES) {
      const delay = backoff.fullJitter(attempt);
      metrics.totalRetries++;
      entry.errors.push({ attempt, error: err.message, at: new Date().toISOString() });
      
      await sleep(delay);
      return processRequest(entry, attempt + 1);
    }
    
    clearTimeout(entry.timeout);
    dlq.add({ ...entry, reason: `Network error: ${err.message}`, attempts: attempt + 1 });
    metrics.totalDLQ++;
    if (!entry.res.headersSent) {
      entry.res.status(503).json({ error: { type: 'network_error', message: err.message, dlq_id: entry.id } });
    }
  }
}

function mapPriority(header) {
  const map = { 'HIGH': 'HIGH', 'MEDIUM': 'MEDIUM', 'LOW': 'LOW' };
  return map[(header || '').toUpperCase()] || 'MEDIUM';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── OPTIONAL: Adaptive rate limit detection ───
// Poll the mock server's /metrics to detect if judge changed RPM/TPM
async function adaptiveLimitPoller() {
  while (true) {
    try {
      const result = await providerClient.getMetrics();
      if (result && result.config) {
        throttle.updateLimits(result.config.rpm_limit, result.config.tpm_limit);
      }
    } catch (e) { /* provider might be down */ }
    await sleep(5000);
  }
}

// ─── START ───
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     LLM ORCHESTRATION ENGINE — QUEUE MASTER              ║
╠══════════════════════════════════════════════════════════╣
║  Engine      →  http://localhost:${PORT}                     ║
║  Provider    →  http://localhost:3999                     ║
║  Metrics     →  http://localhost:${PORT}/metrics              ║
║  DLQ         →  http://localhost:${PORT}/dlq                  ║
╠══════════════════════════════════════════════════════════╣
║  Queue       →  3-tier priority (HIGH/MEDIUM/LOW)         ║
║  Throttle    →  Sliding window (RPM + TPM)                ║
║  Backoff     →  Full jitter + Decorrelated jitter         ║
║  Circuit     →  CLOSED → OPEN → HALF_OPEN                ║
║  DLQ         →  In-memory, never drop silently            ║
╚══════════════════════════════════════════════════════════╝
  `);
  
  // Start the drain loop
  drainLoop().catch(console.error);
  
  // Start adaptive limit detection
  adaptiveLimitPoller().catch(() => {});
});
```

---

## What Changed from the Original Plan

| Original Plan | Revised Plan | Why |
|---|---|---|
| Next.js + React + shadcn dashboard | **Pure Express, no frontend** | 2-hour hackathon. Dashboard is 0 points. Metrics endpoint is 25 points. |
| Supabase (Postgres) | **In-memory arrays/objects** | No time for DB setup. All state is ephemeral. |
| Upstash Redis | **In-memory** | Zero external dependencies. One `npm install` and go. |
| Langfuse integration | **Custom metrics endpoint** | Judges use `curl /metrics` and `judge.js watch`. Langfuse adds zero value here. |
| Multi-provider routing (OpenAI, Anthropic, Gemini) | **Single mock provider on :3999** | Problem brief provides ONE provider. Multi-provider is Level 3 bonus only if time permits. |
| Team-based cost governance (our original use case) | **Dropped for hackathon** | Cool idea but not what's being scored. Focus on the 4 core requirements. |
| OpenAI-compatible proxy with team API keys | **Direct proxy, no auth** | Load test sends raw requests. No auth layer needed. |
| Budget enforcement, per-team spend | **Not applicable** | Single provider, no teams. Pure orchestration focus. |
| Streaming support | **Not needed** | Mock server doesn't stream. |

---

## The "2 Rate Limiting Algorithms" Requirement

The README says: *"Implement at least 2 rate limiting algorithms (your choice)"*

Our two algorithms:
1. **Sliding Window Counter** — Track requests and tokens in a rolling 60-second window. This is the primary throttle that gates the drain loop.
2. **Token Bucket** — Secondary algorithm. Bucket starts full (10 tokens for RPM, 20000 for TPM). Each request consumes from the bucket. Bucket refills at a constant rate (10/60 per second for RPM). When bucket is empty, requests wait.

Expose both in the metrics endpoint under `algorithms.rate_limiting` so judges see them explicitly.

**Implementation strategy:** Use Sliding Window as the primary gate in the drain loop. Use Token Bucket as the secondary validation right before actually firing the request. Belt and suspenders — if either says "no", we wait.

---

## Demo Sequence (18:00 Presentation)

### Step 1: Start everything
```bash
# Terminal 1: Mock provider
cd mock-server && npm install && node server.js

# Terminal 2: Our engine
cd engine && npm install && node server.js
```

### Step 2: Show the "before" picture
```bash
node loadtest.js --direct
# → Shows 429s hitting callers. "This is the problem."
```

### Step 3: Show the "after" picture
```bash
node loadtest.js
# → Zero 429s. "This is the solution."
```

### Step 4: Show metrics
```bash
curl http://localhost:4000/metrics | jq .
# → Queue depth, per-priority latency, throttle utilization, circuit breaker state
```

### Step 5: Judge kills provider
```bash
node judge.js kill
# Fire a few requests → show circuit breaker opening → requests going to DLQ
curl http://localhost:4000/metrics | jq '.circuit_breaker'
curl http://localhost:4000/dlq | jq '.count'
```

### Step 6: Judge revives provider
```bash
node judge.js revive
# Show circuit breaker transitioning HALF_OPEN → CLOSED
# Show DLQ entries that were captured
```

### Step 7: Judge tightens limits
```bash
node judge.js tighten
# RPM drops to 5 — show engine adapting (adaptive limit poller)
node loadtest.js --users=20
# Still zero 429s — just slower drain
```

### Step 8: Nexen Vision Slide
One paragraph: *"Deploy as a sidecar container or shared API gateway (Kong/Envoy plugin). Every CloudAngles platform points their LLM SDK to the gateway URL instead of the provider directly. Per-tenant quota enforcement via X-Tenant-ID header. Redis for shared state across gateway instances. At 10x load, the binding constraint is queue memory — swap to Redis Streams for persistence and horizontal scaling."*

---

## Build Order (Optimized for 2 Hours)

### Hour 1: Core Engine (Must-Haves)

| Time | Task | File |
|---|---|---|
| 0:00–0:10 | Project setup, `npm init`, install express+uuid, create folder structure | `package.json` |
| 0:10–0:15 | Token estimator (copy mock server formula exactly) | `lib/token-estimator.js` |
| 0:15–0:25 | Backoff (full jitter + decorrelated jitter) | `lib/backoff.js` |
| 0:20–0:35 | Priority queue (3-tier with starvation guard) | `lib/queue.js` |
| 0:30–0:45 | Sliding window throttle (RPM + TPM) + token bucket | `lib/throttle.js` |
| 0:40–0:50 | Provider HTTP client | `lib/provider-client.js` |
| 0:45–0:55 | Circuit breaker | `lib/circuit-breaker.js` |
| 0:50–1:00 | Dead letter queue | `lib/dlq.js` |

### Hour 2: Integration + Polish

| Time | Task | File |
|---|---|---|
| 1:00–1:25 | Main server — wire orchestrator loop, endpoints, drain loop | `server.js` |
| 1:25–1:35 | Metrics collector + GET /metrics endpoint | `lib/metrics.js` |
| 1:35–1:45 | **FIRST LOAD TEST** — run `node loadtest.js`, fix any 429 leaks | Testing |
| 1:45–1:50 | Test circuit breaker — `node judge.js kill` mid-load | Testing |
| 1:50–1:55 | Test tightened limits — `node judge.js tighten` + load test | Testing |
| 1:55–2:00 | Write Nexen deployment paragraph. Final metrics check. | `README.md` |

---

## Edge Cases to Handle

1. **Request arrives when circuit is OPEN** → Immediately DLQ + respond 503 (don't queue and wait)
2. **Request times out in queue (>29s)** → DLQ + respond 504 (before loadtest's 30s timeout)
3. **429 during processing** → Retry with backoff. Unrecord from throttle window since capacity wasn't consumed.
4. **Judge tightens RPM to 5 mid-test** → Adaptive poller detects change within 5s, updates throttle limits
5. **All retries exhausted** → DLQ, never drop silently. Respond to caller with DLQ ID.
6. **Provider returns non-JSON** → Catch parse error, treat as 503, trigger circuit breaker logic
7. **Provider connection refused** → Network error path, circuit breaker failure, retry with backoff
8. **Queue drains while circuit is OPEN** → All queued items go to DLQ with 503 response, not left hanging

---

## Key NPM Dependencies

```json
{
  "name": "llm-orchestration-engine",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^5.2.1",
    "uuid": "^14.0.0"
  }
}
```

**That's it. Two dependencies. One command: `node server.js`.**

---

## Traps from Problem Brief — How We Handle Each

| Trap | Our Solution |
|---|---|
| **Throttling on RPM only, ignoring TPM** | Sliding window tracks BOTH rpm and tpm. `canSend()` checks both before releasing from queue. |
| **Backoff without jitter** | Two jitter algorithms implemented: full jitter (primary) and decorrelated jitter (secondary). Both exported and used in different failure paths. |
| **Priority starvation** | Starvation guard promotes LOW→MEDIUM after 30s wait. Tested by verifying LOW requests eventually complete during heavy HIGH traffic. |
| **Dropping requests silently** | Every failed request goes to DLQ with full context (original payload, error history, timestamps). DLQ exposed via `/dlq` endpoint. Count shown in `/metrics`. |