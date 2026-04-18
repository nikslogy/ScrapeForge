Good, I have the full picture. Here's the complete runbook:

---

## ScrapeForge — Full Run & Test Guide

### Prerequisites
- **Docker Desktop** running (for Redis, PostgreSQL, Prometheus, Grafana)
- **Node.js 20+** installed
- Terminal open in `D:\Scrapper-revamp`

---

### Step 1: Start Docker containers

```powershell
docker compose -f infra/docker-compose.yml up -d
```

This starts 4 services:

| Service | Port | Purpose |
|---|---|---|
| Redis | `6379` | Cache + BullMQ queues |
| PostgreSQL | `5433` | Main database |
| Prometheus | `9090` | Metrics collection |
| Grafana | `3002` | Dashboards (admin / scrapeforge) |

Verify they're healthy:

```powershell
docker compose -f infra/docker-compose.yml ps
```

All should show `running` / `healthy`.

---

### Step 2: Install dependencies + build shared package

```powershell
npm install
npm run build -w packages/shared
```

---

### Step 3: Seed the database (creates test user + API key)

```powershell
npm run seed
```

**IMPORTANT**: Copy the `sf_live_...` key printed to the console. You need it for every API call. If you've already seeded before and lost the key, you can re-run seed — it will create a new key for the same user.

---

### Step 4: Start the 3 services (each in its own terminal)

**Terminal 1 — API server** (port 3000):
```powershell
npm run dev:api
```

**Terminal 2 — Worker**:
```powershell
npm run dev:worker
```

**Terminal 3 — Dashboard** (port 3001):
```powershell
npm run dev:dashboard
```

Wait for each to show its startup message before moving on.

---

### Step 5: Test the API

**Basic scrape:**
```powershell
curl.exe -X POST http://localhost:3000/v1/scrape -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_API_KEY" -d "{\"url\":\"https://example.com\",\"formats\":[\"markdown\"]}"
```

**AI extract (requires GEMINI_API_KEY in .env):**
```powershell
curl.exe -X POST http://localhost:3000/v1/extract -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_API_KEY" -d "{\"url\":\"https://example.com\",\"formats\":[\"markdown\"],\"schema\":{\"properties\":{\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"}}}}"
```

**Screenshot (uses browser tier):**
```powershell
curl.exe -X POST http://localhost:3000/v1/scrape -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_API_KEY" -d "{\"url\":\"https://example.com\",\"formats\":[\"markdown\",\"screenshot\"],\"screenshot\":true}"
```

**Key rotation:**
```powershell
curl.exe -X POST http://localhost:3000/v1/keys/rotate -H "Authorization: Bearer YOUR_API_KEY"
```

**Health + Metrics:**
```powershell
curl.exe http://localhost:3000/health
curl.exe http://localhost:3000/metrics
```

**Worker metrics:**
```powershell
curl.exe http://localhost:9091/metrics
```

---

### Step 6: Dashboard

Open **http://localhost:3001** in your browser.

Login with: `dev@scrapeforge.io`

Pages to explore:
- **Overview** — Stats, charts for requests over time and tier breakdown
- **API Keys** — Create / revoke keys (full key shown once on create)
- **Usage** — Daily breakdown by tier with date range filter
- **Logs** — Filterable request log with expandable detail rows
- **Playground** — The interactive API tester with:
  - Scrape vs Extract mode toggle
  - All options (format, proxy, screenshot, mobile, waitFor, blockResources)
  - SSE live events tab showing real-time progress
  - Cost breakdown, quality score, tier info
  - Screenshot preview, extracted JSON highlight
- **Settings** — Plan info, Stripe upgrade/billing buttons

---

### Step 7: Grafana dashboards

Open **http://localhost:3002** — login `admin` / `scrapeforge`

Navigate to **Dashboards → ScrapeForge** folder. You'll see 4 dashboards:
- **Overview** — Requests/sec, success rate, P95 latency, cost/hour
- **Browser Pool** — Context utilization, worker memory
- **Proxy Health** — Success rate by provider, cost by tier
- **Queue** — Depth, jobs/sec, processing time, LLM cost

Make a few API requests first so data shows up.

---

### Step 8: Load testing (optional, requires k6)

Install k6 from https://k6.io, then:

```powershell
k6 run -e API_KEY=YOUR_API_KEY tests/load/k6-load-test.js
```

---

### Quick reference — all URLs

| What | URL |
|---|---|
| API | http://localhost:3000 |
| API Metrics | http://localhost:3000/metrics |
| Worker Metrics | http://localhost:9091/metrics |
| Dashboard | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3002 |

Replace `YOUR_API_KEY` with the `sf_live_...` key from the seed step in every command.