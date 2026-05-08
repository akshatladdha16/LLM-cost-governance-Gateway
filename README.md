# Build & Battle — Queue Master
## Mock LLM Provider · Drop at 16:00 Sharp

---

## What you have

A mock LLM provider that behaves exactly like a real one — with rate limits, realistic latency, and failure modes. Your job is to build an orchestration engine that sits in front of it.

**Your engine must accept requests on port 4000.**
**The mock provider runs on port 3999.**

---

## Start the mock provider

```bash
npm install
node server.js
```

You'll see:
```
Endpoint  →  http://localhost:3999
Limits    →  10 RPM  |  20000 TPM
```

---

## Provider API (OpenAI-compatible)

```
POST http://localhost:3999/v1/chat/completions
```

**Request:**
```json
{
  "model": "mock-llm-provider-v1",
  "max_tokens": 200,
  "messages": [
    { "role": "user", "content": "Your prompt here" }
  ]
}
```

**Success (200):**
```json
{
  "id": "mock-uuid",
  "object": "chat.completion",
  "choices": [{ "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 45, "completion_tokens": 120, "total_tokens": 165 }
}
```

**Rate limited (429):**
```json
{
  "error": {
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded",
    "message": "Rate limit exceeded: 10/10 RPM. Retry after 12s.",
    "limit_type": "RPM",
    "retry_after_seconds": 12
  }
}
```

**Provider down (503):**
```json
{
  "error": {
    "type": "service_unavailable",
    "code": 503,
    "message": "LLM provider is currently unavailable.",
    "killed": true
  }
}
```

---

## Rate limit headers

Every response includes:
```
X-RateLimit-Limit-Requests: 10
X-RateLimit-Remaining-Requests: 7
X-RateLimit-Limit-Tokens: 20000
X-RateLimit-Remaining-Tokens: 14200
Retry-After: 12   (on 429 only)
```

---

## Monitor the provider

```bash
curl http://localhost:3999/metrics
curl http://localhost:3999/health
```

---

## Run the load test (against YOUR engine on port 4000)

```bash
# Test your engine — 50 concurrent users
node loadtest.js

# Custom user count
node loadtest.js --users=100

# See what happens WITHOUT an engine (direct to mock — expect 429s)
node loadtest.js --direct
```

**Passing score: Zero 429s reach the caller during the load test.**

---

## Limits to respect

| Limit | Value |
|-------|-------|
| Requests per minute (RPM) | 10 |
| Tokens per minute (TPM) | 20,000 |
| Max tokens per request | 4,000 |
| Base latency | 300–700ms |

---

## What your engine must do

1. Accept requests on `POST http://localhost:4000/v1/chat/completions`
2. Queue and throttle to stay within 10 RPM and 20,000 TPM
3. Implement at least 2 rate limiting algorithms (your choice)
4. Retry with exponential backoff + jitter on 429
5. Handle 503 (provider killed) gracefully — circuit breaker, not crash
6. Send failed requests to a dead letter queue — never drop silently
7. Expose metrics at `GET http://localhost:4000/metrics`

---

## Deliverables at 18:00

- [ ] Engine starts with one command
- [ ] Load test passes with zero 429s leaking to caller
- [ ] Redis failure handled (if you used Redis)
- [ ] Live demo: fire load test → show metrics → judge kills provider → show circuit breaker
- [ ] One paragraph: where does your engine break at 10x load?

---

*CloudAngles · Build & Battle · Edition 01 · Queue Master*
