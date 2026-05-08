/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          BUILD & BATTLE — LOAD TEST SCRIPT                  ║
 * ║   Fires 50 concurrent users at the orchestration engine.    ║
 * ║   Run this against YOUR engine, not the mock directly.      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node loadtest.js                        # default: 50 users, your engine on 4000
 *   node loadtest.js --users=100            # custom user count
 *   node loadtest.js --target=http://localhost:4000   # custom engine URL
 *   node loadtest.js --direct               # hit mock LLM directly (shows what WITHOUT orchestration looks like)
 */

const http = require('http');
const https = require('https');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace('--', '').split('=');
    return [k, v ?? true];
  })
);

const CONCURRENT_USERS = parseInt(args.users) || 50;
const TARGET_URL = args.target || 'http://localhost:4000';
const DIRECT_MODE = !!args.direct;
const ENDPOINT = DIRECT_MODE ? 'http://localhost:3999' : TARGET_URL;
const REQUESTS_PER_USER = parseInt(args.requests) || 3;

const PROMPTS = [
  { role: 'user', content: 'Explain how a distributed rate limiter works in production systems.' },
  { role: 'user', content: 'What are the tradeoffs between token bucket and sliding window algorithms?' },
  { role: 'user', content: 'Describe the circuit breaker pattern and when to use it.' },
  { role: 'user', content: 'How do you prevent retry storms in distributed systems?' },
  { role: 'user', content: 'What is the difference between RPM and TPM rate limiting?' },
  { role: 'user', content: 'Explain exponential backoff with jitter.' },
  { role: 'user', content: 'How would you implement a dead letter queue for failed LLM requests?' },
  { role: 'user', content: 'What is priority queue starvation and how do you prevent it?' },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function post(url, body) {
  return new Promise((resolve) => {
    const start = Date.now();
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-User-ID': `user-${Math.floor(Math.random() * CONCURRENT_USERS)}`,
        'X-Priority': pick(['HIGH', 'MEDIUM', 'LOW']),
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            latency: Date.now() - start,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode, latency: Date.now() - start, body: data });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, latency: Date.now() - start, error: err.message });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ status: 0, latency: Date.now() - start, error: 'TIMEOUT' });
    });

    req.write(payload);
    req.end();
  });
}

async function runUser(userId) {
  const results = [];
  for (let i = 0; i < REQUESTS_PER_USER; i++) {
    const result = await post(`${ENDPOINT}/v1/chat/completions`, {
      model: 'mock-llm-provider-v1',
      max_tokens: 150 + Math.floor(Math.random() * 200),
      messages: [pick(PROMPTS)],
    });
    results.push({ userId, requestNum: i + 1, ...result });
    // small random delay between requests from same user
    await new Promise(r => setTimeout(r, Math.random() * 200));
  }
  return results;
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          BUILD & BATTLE — LOAD TEST                      ║
╠══════════════════════════════════════════════════════════╣
║  Mode      →  ${DIRECT_MODE ? 'DIRECT (no orchestration) ⚠️ ' : 'VIA ORCHESTRATION ENGINE ✓ '}           ║
║  Target    →  ${ENDPOINT.padEnd(42)} ║
║  Users     →  ${String(CONCURRENT_USERS).padEnd(42)} ║
║  Req/user  →  ${String(REQUESTS_PER_USER).padEnd(42)} ║
║  Total     →  ${String(CONCURRENT_USERS * REQUESTS_PER_USER).padEnd(42)} ║
╚══════════════════════════════════════════════════════════╝
`);

  if (DIRECT_MODE) {
    console.log('⚠️  DIRECT MODE: Hitting mock LLM directly. Expect 429s. This is the BEFORE picture.\n');
  } else {
    console.log('✓  ENGINE MODE: Hitting your orchestration engine. 429s should never reach here.\n');
  }

  console.log(`Firing ${CONCURRENT_USERS} users simultaneously...\n`);
  const startTime = Date.now();

  const userPromises = Array.from({ length: CONCURRENT_USERS }, (_, i) => runUser(i + 1));
  const allResults = (await Promise.all(userPromises)).flat();

  const totalTime = Date.now() - startTime;

  // ── STATS ─────────────────────────────────
  const succeeded   = allResults.filter(r => r.status === 200);
  const rateLimited = allResults.filter(r => r.status === 429);
  const errors      = allResults.filter(r => r.status === 0);
  const serverErrors = allResults.filter(r => r.status >= 500);
  const latencies   = succeeded.map(r => r.latency).sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  console.log('═══════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log(`  Total requests   : ${allResults.length}`);
  console.log(`  Succeeded        : ${succeeded.length} (${Math.round(succeeded.length / allResults.length * 100)}%)`);
  console.log(`  Rate limited 429 : ${rateLimited.length} (${Math.round(rateLimited.length / allResults.length * 100)}%)`);
  console.log(`  Server errors    : ${serverErrors.length}`);
  console.log(`  Connection errors: ${errors.length}`);
  console.log(`  Total time       : ${totalTime}ms`);
  console.log('');
  console.log('  LATENCY (succeeded requests)');
  console.log(`  Avg : ${avg}ms`);
  console.log(`  p50 : ${p50}ms`);
  console.log(`  p95 : ${p95}ms`);
  console.log(`  p99 : ${p99}ms`);
  console.log('');

  if (rateLimited.length > 0) {
    console.log('  ⚠️  RATE LIMITED SAMPLE:');
    rateLimited.slice(0, 2).forEach(r => {
      const msg = r.body?.error?.message || 'no message';
      console.log(`     User ${r.userId} req ${r.requestNum}: ${msg.substring(0, 80)}`);
    });
    console.log('');
  }

  if (DIRECT_MODE) {
    console.log(`  📊 VERDICT (DIRECT): ${rateLimited.length} requests hit 429. This is the problem your engine must solve.`);
  } else {
    if (rateLimited.length === 0) {
      console.log('  ✅ VERDICT: ZERO 429s reached the caller. Orchestration engine is working.');
    } else {
      console.log(`  ❌ VERDICT: ${rateLimited.length} 429s leaked through. Engine needs work.`);
    }
  }

  console.log('═══════════════════════════════════════════\n');
}

main().catch(console.error);
