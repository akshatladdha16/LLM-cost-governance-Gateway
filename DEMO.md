# Demo Runbook (All Functionalities)

This runbook demonstrates all required capabilities end-to-end.

## 1) Start services (2 terminals)

Terminal A (provider):

```bash
node server.js
```

Terminal B (engine):

```bash
cd engine
npm start
```

## 2) One-shot scripted demo

From repo root:

```bash
./scripts/demo-cases.sh
```

This script runs all cases below in sequence.

## 3) Manual demo order (presentation-friendly)

### Case A: Baseline problem without orchestration

```bash
node judge.js reset
node scripts/rpm-proof.js 12 http://localhost:3999/v1/chat/completions
```

Expected: mix of `200` and `429` when hitting provider directly.

**Demo Script:**
- "First I show the raw provider behavior with no protection layer ie. our middleware. this shows the current scenerio and the failing pointts in our system design principles."
- "These 429s are the core problem we wish to solve. "
- "Now I'll run the same style of traffic through our orchestration engine that sits on top of our application."

### Case B: Engine happy path (no leaked 429)  our proposed solution

```bash
node loadtest.js --users=8 --requests=1 --target=http://localhost:4000
curl -s http://localhost:4000/metrics
```

Expected: `Rate limited 429 : 0` in loadtest output.

**Demo Script:**
- "Now traffic goes through port 4000, our orchestration layer."
- "Notice caller-facing 429 is zero, which is our primary score objective."
- "Queueing and throttling absorb provider limits while keeping client contract stable."

### Case C: Queue timeout + DLQ behavior under stress

```bash
node loadtest.js --users=20 --requests=1 --target=http://localhost:4000
curl -s http://localhost:4000/dlq
```

Expected: still `429 : 0`, but some `5xx` and DLQ entries due 29s timeout.

**Demo Script:**
- "Under heavier burst load, we still do not leak 429."
- "When we cannot complete within the 29-second client window, we fail safely to DLQ."
- "This proves we never drop requests silently and always preserve failure context."

### Case D: Circuit breaker open on provider outage

```bash
node judge.js kill
curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"mock-llm-provider-v1","max_tokens":120,"messages":[{"role":"user","content":"provider down test"}]}'
curl -s http://localhost:4000/metrics
```

Expected: engine returns `503`, metrics show circuit `OPEN` and status `DEGRADED`.

**Demo Script:**
- "Judge kills the provider; this simulates a real outage."
- "Our breaker trips OPEN after repeated 503s and protects the rest of the system."
- "Requests now fail fast with clear error semantics and DLQ IDs."

### Case E: Circuit recovery (half-open -> closed)

```bash
node judge.js revive
sleep 16
curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"mock-llm-provider-v1","max_tokens":100,"messages":[{"role":"user","content":"probe one"}]}'
curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"mock-llm-provider-v1","max_tokens":100,"messages":[{"role":"user","content":"probe two"}]}'
curl -s http://localhost:4000/metrics
```

Expected: circuit events include `OPEN -> HALF_OPEN -> CLOSED`.

**Demo Script:**
- "After revive, we wait for cooldown and send probe traffic."
- "Breaker transitions to HALF_OPEN, validates recovery, then closes automatically."
- "No manual intervention is required for healthy recovery flow."

### Case F: Adaptive limit change (judge tighten)

```bash
node judge.js tighten
sleep 6
curl -s http://localhost:4000/metrics
```

Expected: engine throttle limits update to `rpm_limit: 5`, `tpm_limit: 10000`.

**Demo Script:**
- "Now the judge tightens limits live to increase pressure."
- "Our adaptive poller picks up the new limits and updates throttle policy."
- "Behavior remains controlled: slower drain, still no leaked 429s."

### Case G: DLQ replay

```bash
DLQ_ID=$(curl -s http://localhost:4000/dlq | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const d=JSON.parse(s);if(!d.entries||!d.entries.length){process.exit(2)};process.stdout.write(d.entries[d.entries.length-1].id);});")
curl -s -X POST "http://localhost:4000/dlq/replay/$DLQ_ID"
curl -s http://localhost:4000/dlq
```

Expected: replay returns a normal completion response and DLQ count drops by one.

**Demo Script:**
- "Finally, I replay a failed request from DLQ back through the same pipeline."
- "Replay succeeds and DLQ count decreases, showing operational recoverability."
- "This closes the loop: absorb, preserve, recover."

## 4) Final reset before handoff

```bash
node judge.js loosen
node judge.js revive
```

## Speaking points (short)

- We eliminate leaked provider `429`s at caller boundary using queue + throttle.
- We preserve failure context in DLQ instead of dropping requests silently.
- Circuit breaker protects callers during provider outage and auto-recovers.
- Adaptive poller tracks live provider limit changes (tighten/loosen).
