/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          BUILD & BATTLE — MOCK LLM PROVIDER SERVER          ║
 * ║                    CODENAME: QUEUE MASTER                    ║
 * ║           DROP THIS AT 16:00. DO NOT SHARE EARLY.           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Simulates an LLM provider (Anthropic/OpenAI-compatible API)
 * with configurable rate limits, token tracking, latency,
 * failure modes, and a kill switch for the circuit breaker demo.
 *
 * Start: node server.js
 * Default: http://localhost:3999
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// RATE LIMIT CONFIGURATION
// Contestants must stay within these boundaries.
// ─────────────────────────────────────────────
const CONFIG = {
  RPM: 10,          // max requests per minute
  TPM: 20000,       // max tokens per minute
  MAX_TOKENS_PER_REQUEST: 4000,
  BASE_LATENCY_MS: 300,     // simulated LLM thinking time
  LATENCY_JITTER_MS: 400,   // random additional delay
  TOKENS_PER_WORD: 1.3,     // rough token estimator
};

// ─────────────────────────────────────────────
// STATE — rolling 60-second windows
// ─────────────────────────────────────────────
const state = {
  requestLog: [],     // { timestamp, tokens }
  totalRequests: 0,
  totalTokens: 0,
  totalRateLimited: 0,
  totalSucceeded: 0,
  isKilled: false,    // circuit breaker kill switch
  killReason: null,
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function now() { return Date.now(); }

function windowedCount(windowMs = 60000) {
  const cutoff = now() - windowMs;
  return state.requestLog.filter(r => r.timestamp > cutoff);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateTokens(messages, maxTokens) {
  const text = messages.map(m => m.content || '').join(' ');
  const inputTokens = Math.ceil(text.split(' ').length * CONFIG.TOKENS_PER_WORD);
  const outputTokens = maxTokens || 200;
  return { inputTokens, outputTokens, total: inputTokens + outputTokens };
}

function mockResponse(messages, maxTokens) {
  const prompts = [
    "The system processed your request successfully through the orchestration layer.",
    "Query acknowledged. The distributed queue handled this request with optimal priority routing.",
    "Response generated. Your rate limiter is working correctly if you're seeing this.",
    "Inference complete. Token budget consumed within provider limits.",
    "The mock LLM has processed your input. Latency was simulated for realism.",
    "Context window evaluated. Output generated within the requested token budget.",
    "Model inference successful. This response confirms your orchestration layer is functioning.",
  ];
  const text = prompts[Math.floor(Math.random() * prompts.length)];
  const { inputTokens, outputTokens } = estimateTokens(messages, maxTokens);
  return {
    id: `mock-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: 'mock-llm-provider-v1',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

function purgeOldLogs() {
  const cutoff = now() - 60000;
  state.requestLog = state.requestLog.filter(r => r.timestamp > cutoff);
}

// ─────────────────────────────────────────────
// MIDDLEWARE: request logger
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path !== '/metrics' && req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─────────────────────────────────────────────
// POST /v1/chat/completions  (OpenAI-compatible)
// POST /v1/messages          (Anthropic-compatible)
// ─────────────────────────────────────────────
async function handleLLMRequest(req, res) {
  state.totalRequests++;
  purgeOldLogs();

  // ── KILL SWITCH CHECK ─────────────────────
  if (state.isKilled) {
    return res.status(503).json({
      error: {
        type: 'service_unavailable',
        code: 503,
        message: state.killReason || 'LLM provider is currently unavailable.',
        killed: true,
      }
    });
  }

  const body = req.body;
  const messages = body.messages || [];
  const maxTokens = body.max_tokens || 200;
  const { total: estimatedTokens } = estimateTokens(messages, maxTokens);

  // ── TOKEN LIMIT PER REQUEST ───────────────
  if (estimatedTokens > CONFIG.MAX_TOKENS_PER_REQUEST) {
    state.totalRateLimited++;
    return res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'max_tokens_exceeded',
        message: `Estimated tokens (${estimatedTokens}) exceed per-request max (${CONFIG.MAX_TOKENS_PER_REQUEST}).`,
        estimated_tokens: estimatedTokens,
        max_allowed: CONFIG.MAX_TOKENS_PER_REQUEST,
      }
    });
  }

  const recentRequests = windowedCount();
  const recentTokens = recentRequests.reduce((sum, r) => sum + r.tokens, 0);

  // ── RPM CHECK ─────────────────────────────
  if (recentRequests.length >= CONFIG.RPM) {
    state.totalRateLimited++;
    const oldestInWindow = recentRequests[0].timestamp;
    const retryAfterMs = 60000 - (now() - oldestInWindow);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    res.set('Retry-After', retryAfterSec);
    res.set('X-RateLimit-Limit-Requests', CONFIG.RPM);
    res.set('X-RateLimit-Remaining-Requests', 0);
    res.set('X-RateLimit-Reset-Requests', new Date(oldestInWindow + 60000).toISOString());

    return res.status(429).json({
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: `Rate limit exceeded: ${recentRequests.length}/${CONFIG.RPM} RPM. Retry after ${retryAfterSec}s.`,
        limit_type: 'RPM',
        current: recentRequests.length,
        limit: CONFIG.RPM,
        retry_after_seconds: retryAfterSec,
      }
    });
  }

  // ── TPM CHECK ─────────────────────────────
  if (recentTokens + estimatedTokens > CONFIG.TPM) {
    state.totalRateLimited++;
    const remaining = CONFIG.TPM - recentTokens;

    res.set('X-RateLimit-Limit-Tokens', CONFIG.TPM);
    res.set('X-RateLimit-Remaining-Tokens', Math.max(0, remaining));

    return res.status(429).json({
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: `Token rate limit exceeded: ${recentTokens + estimatedTokens}/${CONFIG.TPM} TPM.`,
        limit_type: 'TPM',
        current_window_tokens: recentTokens,
        requested_tokens: estimatedTokens,
        limit: CONFIG.TPM,
        retry_after_seconds: 15,
      }
    });
  }

  // ── SIMULATE LATENCY ──────────────────────
  const latency = CONFIG.BASE_LATENCY_MS + Math.random() * CONFIG.LATENCY_JITTER_MS;
  await sleep(latency);

  // ── RECORD AND RESPOND ────────────────────
  state.requestLog.push({ timestamp: now(), tokens: estimatedTokens });
  state.totalSucceeded++;
  state.totalTokens += estimatedTokens;

  const recentAfter = windowedCount();
  const tokensAfter = recentAfter.reduce((s, r) => s + r.tokens, 0);

  res.set('X-RateLimit-Limit-Requests', CONFIG.RPM);
  res.set('X-RateLimit-Remaining-Requests', CONFIG.RPM - recentAfter.length);
  res.set('X-RateLimit-Limit-Tokens', CONFIG.TPM);
  res.set('X-RateLimit-Remaining-Tokens', CONFIG.TPM - tokensAfter);
  res.set('X-Processing-Time-Ms', Math.round(latency));

  return res.status(200).json(mockResponse(messages, maxTokens));
}

app.post('/v1/chat/completions', handleLLMRequest);
app.post('/v1/messages', handleLLMRequest);

// ─────────────────────────────────────────────
// GET /health — basic liveness check
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: state.isKilled ? 'killed' : 'healthy',
    killed: state.isKilled,
    kill_reason: state.killReason,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// GET /metrics — contestants monitor this
// ─────────────────────────────────────────────
app.get('/metrics', (req, res) => {
  purgeOldLogs();
  const recent = windowedCount();
  const recentTokens = recent.reduce((s, r) => s + r.tokens, 0);

  res.json({
    provider: 'mock-llm-v1',
    status: state.isKilled ? 'KILLED' : 'ACTIVE',
    config: {
      rpm_limit: CONFIG.RPM,
      tpm_limit: CONFIG.TPM,
      max_tokens_per_request: CONFIG.MAX_TOKENS_PER_REQUEST,
    },
    current_window: {
      requests_last_60s: recent.length,
      tokens_last_60s: recentTokens,
      rpm_utilisation_pct: Math.round((recent.length / CONFIG.RPM) * 100),
      tpm_utilisation_pct: Math.round((recentTokens / CONFIG.TPM) * 100),
    },
    totals: {
      total_requests: state.totalRequests,
      total_succeeded: state.totalSucceeded,
      total_rate_limited: state.totalRateLimited,
      total_tokens_consumed: state.totalTokens,
      rate_limited_pct: state.totalRequests > 0
        ? Math.round((state.totalRateLimited / state.totalRequests) * 100)
        : 0,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// POST /admin/kill — CIRCUIT BREAKER DEMO
// Body: { "reason": "Simulated provider outage" }
// ─────────────────────────────────────────────
app.post('/admin/kill', (req, res) => {
  state.isKilled = true;
  state.killReason = req.body.reason || 'Provider killed by admin for circuit breaker demo.';
  console.log(`\n🔴 PROVIDER KILLED: ${state.killReason}\n`);
  res.json({ status: 'killed', reason: state.killReason, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// POST /admin/revive — bring it back
// ─────────────────────────────────────────────
app.post('/admin/revive', (req, res) => {
  state.isKilled = false;
  state.killReason = null;
  console.log('\n🟢 PROVIDER REVIVED\n');
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// POST /admin/config — change limits live
// Body: { "RPM": 5, "TPM": 10000 }
// ─────────────────────────────────────────────
app.post('/admin/config', (req, res) => {
  const { RPM, TPM, BASE_LATENCY_MS } = req.body;
  if (RPM) CONFIG.RPM = RPM;
  if (TPM) CONFIG.TPM = TPM;
  if (BASE_LATENCY_MS) CONFIG.BASE_LATENCY_MS = BASE_LATENCY_MS;
  console.log(`\n⚙️  CONFIG UPDATED: RPM=${CONFIG.RPM} TPM=${CONFIG.TPM}\n`);
  res.json({ status: 'updated', config: CONFIG, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// POST /admin/reset — clear state counters
// ─────────────────────────────────────────────
app.post('/admin/reset', (req, res) => {
  state.requestLog = [];
  state.totalRequests = 0;
  state.totalTokens = 0;
  state.totalRateLimited = 0;
  state.totalSucceeded = 0;
  console.log('\n🔄 STATE RESET\n');
  res.json({ status: 'reset', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3999;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        BUILD & BATTLE — MOCK LLM PROVIDER READY          ║
╠══════════════════════════════════════════════════════════╣
║  Endpoint  →  http://localhost:${PORT}                    ║
║  Limits    →  ${CONFIG.RPM} RPM  |  ${CONFIG.TPM} TPM              ║
║  Latency   →  ${CONFIG.BASE_LATENCY_MS}–${CONFIG.BASE_LATENCY_MS + CONFIG.LATENCY_JITTER_MS}ms per request               ║
╠══════════════════════════════════════════════════════════╣
║  ROUTES                                                  ║
║  POST /v1/chat/completions  →  LLM request (OpenAI)      ║
║  POST /v1/messages          →  LLM request (Anthropic)   ║
║  GET  /health               →  liveness check            ║
║  GET  /metrics              →  live rate limit stats      ║
╠══════════════════════════════════════════════════════════╣
║  ADMIN (for judges only)                                 ║
║  POST /admin/kill    →  trigger circuit breaker demo     ║
║  POST /admin/revive  →  bring provider back              ║
║  POST /admin/config  →  change RPM/TPM live              ║
║  POST /admin/reset   →  clear all counters               ║
╚══════════════════════════════════════════════════════════╝
`);
});
