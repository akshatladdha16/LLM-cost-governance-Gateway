# LLM Orchestration Engine

Minimal hackathon orchestration engine on port `4000`.

## Run

```bash
npm install
npm start
```

## Endpoints

- `POST /v1/chat/completions`
- `GET /metrics`
- `GET /health`
- `GET /dlq`
- `POST /dlq/replay/:id`

## Highlights

- 3-tier priority queue with starvation guard
- Sliding-window RPM/TPM throttling
- Token-bucket secondary limiter
- Circuit breaker (closed/open/half-open)
- Full-jitter and decorrelated-jitter retries
- In-memory DLQ with full failure context
