#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       BUILD & BATTLE — JUDGE'S CONTROL PANEL                ║
 * ║          Use this during the demo. Contestants don't get it. ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node judge.js kill          # kill the LLM provider (circuit breaker test)
 *   node judge.js revive        # bring it back
 *   node judge.js metrics       # live stats
 *   node judge.js tighten       # drop RPM to 5 (stress test)
 *   node judge.js loosen        # restore RPM to 10
 *   node judge.js reset         # clear all counters
 *   node judge.js watch         # live metrics every 3 seconds
 */

const http = require('http');
const MOCK_URL = 'http://localhost:3999';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'localhost',
      port: 3999,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const r = http.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function printMetrics(m) {
  const bar = (pct, len = 30) => {
    const filled = Math.round((pct / 100) * len);
    return '[' + '█'.repeat(filled) + '░'.repeat(len - filled) + ']';
  };
  const status = m.status === 'KILLED' ? '🔴 KILLED' : '🟢 ACTIVE';
  console.clear();
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           BUILD & BATTLE — LIVE PROVIDER METRICS         ║
╠══════════════════════════════════════════════════════════╣
  Status     : ${status}
  Timestamp  : ${m.timestamp}
╠══════════════════════════════════════════════════════════╣
  CURRENT WINDOW (last 60 seconds)
  RPM  ${bar(m.current_window.rpm_utilisation_pct)}  ${m.current_window.requests_last_60s}/${m.config.rpm_limit} (${m.current_window.rpm_utilisation_pct}%)
  TPM  ${bar(m.current_window.tpm_utilisation_pct)}  ${m.current_window.tokens_last_60s}/${m.config.tpm_limit} (${m.current_window.tpm_utilisation_pct}%)
╠══════════════════════════════════════════════════════════╣
  TOTALS
  Total requests   : ${m.totals.total_requests}
  Succeeded        : ${m.totals.total_succeeded}
  Rate limited     : ${m.totals.total_rate_limited} (${m.totals.rate_limited_pct}%)
  Tokens consumed  : ${m.totals.total_tokens_consumed}
╚══════════════════════════════════════════════════════════╝`);
}

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'kill':
      const killRes = await req('POST', '/admin/kill', { reason: 'Simulated provider outage for circuit breaker demo.' });
      console.log('🔴 KILLED:', killRes);
      break;

    case 'revive':
      const reviveRes = await req('POST', '/admin/revive', {});
      console.log('🟢 REVIVED:', reviveRes);
      break;

    case 'metrics':
      const m = await req('GET', '/metrics', null);
      printMetrics(m);
      break;

    case 'tighten':
      const t = await req('POST', '/admin/config', { RPM: 5, TPM: 10000 });
      console.log('⚡ LIMITS TIGHTENED:', t);
      break;

    case 'loosen':
      const l = await req('POST', '/admin/config', { RPM: 10, TPM: 20000 });
      console.log('✅ LIMITS RESTORED:', l);
      break;

    case 'reset':
      const r = await req('POST', '/admin/reset', {});
      console.log('🔄 RESET:', r);
      break;

    case 'watch':
      console.log('Watching metrics (Ctrl+C to stop)...');
      async function loop() {
        const metrics = await req('GET', '/metrics', null).catch(() => null);
        if (metrics) printMetrics(metrics);
        setTimeout(loop, 3000);
      }
      loop();
      break;

    default:
      console.log(`
Build & Battle — Judge Control Panel
Commands:
  node judge.js kill       Kill the provider (circuit breaker demo)
  node judge.js revive     Revive the provider
  node judge.js metrics    Show current metrics
  node judge.js tighten    Drop RPM to 5 (stress test)
  node judge.js loosen     Restore RPM to 10
  node judge.js reset      Clear all counters
  node judge.js watch      Live metrics every 3 seconds
      `);
  }
}

main().catch(console.error);
