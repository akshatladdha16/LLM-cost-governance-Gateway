#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() {
  printf "\n============================================================\n"
  printf "%s\n" "$1"
  printf "============================================================\n"
}

step "0) Normalize provider state"
node "$ROOT_DIR/judge.js" revive || true
node "$ROOT_DIR/judge.js" loosen
node "$ROOT_DIR/judge.js" reset

step "1) Direct baseline (sequential proof of 429s)"
node "$ROOT_DIR/scripts/rpm-proof.js" 12 "http://localhost:3999/v1/chat/completions"

step "2) Engine happy path (no leaked 429s)"
node "$ROOT_DIR/loadtest.js" --users=8 --requests=1 --target=http://localhost:4000

step "3) Engine stress path (timeouts -> DLQ, still no leaked 429s)"
node "$ROOT_DIR/loadtest.js" --users=20 --requests=1 --target=http://localhost:4000
curl -s "http://localhost:4000/dlq"

step "4) Kill provider -> circuit opens"
node "$ROOT_DIR/judge.js" kill
curl -s -X POST "http://localhost:4000/v1/chat/completions" -H "Content-Type: application/json" --data '{"model":"mock-llm-provider-v1","max_tokens":120,"messages":[{"role":"user","content":"provider down test"}]}'
curl -s "http://localhost:4000/metrics"

step "5) Revive provider -> half-open -> closed"
node "$ROOT_DIR/judge.js" revive
sleep 16
curl -s -X POST "http://localhost:4000/v1/chat/completions" -H "Content-Type: application/json" --data '{"model":"mock-llm-provider-v1","max_tokens":100,"messages":[{"role":"user","content":"probe one"}]}'
curl -s -X POST "http://localhost:4000/v1/chat/completions" -H "Content-Type: application/json" --data '{"model":"mock-llm-provider-v1","max_tokens":100,"messages":[{"role":"user","content":"probe two"}]}'
curl -s "http://localhost:4000/metrics"

step "6) Tighten limits -> adaptive throttle"
node "$ROOT_DIR/judge.js" tighten
sleep 6
curl -s "http://localhost:4000/metrics"
node "$ROOT_DIR/loadtest.js" --users=10 --requests=1 --target=http://localhost:4000

step "7) Replay one DLQ entry"
DLQ_ID="$(curl -s "http://localhost:4000/dlq" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const d=JSON.parse(s);if(!d.entries||!d.entries.length){process.exit(2)};process.stdout.write(d.entries[d.entries.length-1].id);});")"
curl -s -X POST "http://localhost:4000/dlq/replay/${DLQ_ID}"
curl -s "http://localhost:4000/dlq"

step "8) Final normalize"
node "$ROOT_DIR/judge.js" loosen
node "$ROOT_DIR/judge.js" revive || true
curl -s "http://localhost:3999/health"
curl -s "http://localhost:4000/health"
curl -s "http://localhost:4000/metrics"
