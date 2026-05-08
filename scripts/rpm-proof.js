#!/usr/bin/env node

const http = require('http');

const count = Number(process.argv[2] || 12);
const target = process.argv[3] || 'http://localhost:3999/v1/chat/completions';

function post(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const body = JSON.stringify({
      model: 'mock-llm-provider-v1',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'sequential direct test' }],
    });

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsedBody = data;
          try {
            parsedBody = JSON.parse(data);
          } catch (_err) {
            // Keep raw body.
          }
          resolve({ status: res.statusCode, body: parsedBody });
        });
      }
    );

    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  const out = { total: count, target, statuses: {} };
  for (let i = 0; i < count; i += 1) {
    const res = await post(target);
    out.statuses[res.status] = (out.statuses[res.status] || 0) + 1;
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
