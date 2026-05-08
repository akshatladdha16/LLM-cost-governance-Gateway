const http = require('http');
const https = require('https');

const MOCK_URL = process.env.LLM_PROVIDER_URL || 'http://localhost:3999';

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const parsed = new URL(MOCK_URL);
    const lib = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const latency = Date.now() - start;
          try {
            const parsedBody = data ? JSON.parse(data) : {};
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: parsedBody,
              latency,
            });
          } catch (_err) {
            reject(new Error(`Invalid JSON from provider: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Provider timeout'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function call(body) {
  return requestJson('POST', '/v1/chat/completions', body);
}

async function getMetrics() {
  const result = await requestJson('GET', '/metrics', null);
  return result.body;
}

module.exports = {
  call,
  getMetrics,
};
