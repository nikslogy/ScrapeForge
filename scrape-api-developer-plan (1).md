# Web Scraping API SaaS — Complete Developer Plan
claude --resume 695d5169-4611-4480-b205-e8bda29681ff
**Project Codename:** ScrapeForge  
**Stack:** Node.js 20 LTS, TypeScript, Fastify, BullMQ, Playwright, Redis, PostgreSQL  
**Target:** DigitalOcean / Hetzner deployment, sub-$50/mo at MVP  
**Date:** March 2026

---

## How to read this document

This plan is divided into **7 phases**. Each phase has:

- **Goal** — What this phase achieves
- **Prerequisites** — What must be done before starting
- **Directory structure** — Exact files to create
- **Implementation steps** — Numbered, sequential tasks
- **Acceptance criteria** — How to verify the phase is complete
- **Commands** — Exact terminal commands to run

Every phase builds on the previous one. Do not skip phases. Do not start Phase N+1 until Phase N passes all acceptance criteria.

---

## Project directory structure (final state)

```
scrapeforge/
├── apps/
│   ├── api/                    # Fastify API server
│   │   ├── src/
│   │   │   ├── server.ts       # Fastify app bootstrap
│   │   │   ├── routes/
│   │   │   │   ├── scrape.ts   # POST /v1/scrape
│   │   │   │   ├── crawl.ts    # POST /v1/crawl
│   │   │   │   ├── extract.ts  # POST /v1/extract
│   │   │   │   ├── batch.ts    # POST /v1/batch
│   │   │   │   ├── status.ts   # GET  /v1/status/:jobId
│   │   │   │   ├── health.ts   # GET  /health
│   │   │   │   └── graphql.ts  # POST /v1/graphql
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # API key validation
│   │   │   │   ├── rate-limiter.ts   # Per-key rate limiting
│   │   │   │   ├── validator.ts      # JSON Schema request validation
│   │   │   │   └── usage-tracker.ts  # Metered usage recording
│   │   │   ├── schemas/
│   │   │   │   ├── scrape.schema.ts  # Zod schemas for /scrape
│   │   │   │   ├── crawl.schema.ts
│   │   │   │   ├── extract.schema.ts
│   │   │   │   └── common.schema.ts
│   │   │   └── plugins/
│   │   │       ├── redis.ts    # Redis connection plugin
│   │   │       ├── postgres.ts # PostgreSQL connection plugin
│   │   │       └── sse.ts      # Server-Sent Events plugin
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── worker/                 # BullMQ worker processes
│   │   ├── src/
│   │   │   ├── worker.ts       # Worker bootstrap + BullMQ consumer
│   │   │   ├── processors/
│   │   │   │   ├── scrape.processor.ts   # Main scrape job handler
│   │   │   │   ├── crawl.processor.ts    # Multi-page crawl handler
│   │   │   │   └── batch.processor.ts    # Bulk URL handler
│   │   │   ├── engine/
│   │   │   │   ├── router.ts             # Smart tier router (decides HTTP vs browser)
│   │   │   │   ├── tier1-http.ts         # impit HTTP fetcher
│   │   │   │   ├── tier2-tls.ts          # curl-cffi TLS impersonation (Python sidecar)
│   │   │   │   ├── tier3-light.ts        # Lightpanda lightweight browser
│   │   │   │   ├── tier4-browser.ts      # Playwright/Patchright full browser
│   │   │   │   └── tier4-stealth.ts      # Camoufox stealth browser
│   │   │   ├── browser/
│   │   │   │   ├── pool.ts               # Browser context pool manager
│   │   │   │   ├── resource-blocker.ts   # Block images/fonts/ads
│   │   │   │   └── fingerprint.ts        # BrowserForge fingerprint rotation
│   │   │   ├── proxy/
│   │   │   │   ├── manager.ts            # Proxy pool manager
│   │   │   │   ├── scorer.ts             # Proxy quality scoring
│   │   │   │   └── providers.ts          # Provider configs (IPRoyal, Webshare, etc.)
│   │   │   ├── extraction/
│   │   │   │   ├── pipeline.ts           # Main extraction orchestrator
│   │   │   │   ├── html-cleaner.ts       # HTML pruning + noise removal
│   │   │   │   ├── markdown.ts           # HTML → Markdown via Readability
│   │   │   │   ├── ai-extractor.ts       # LLM-based structured extraction
│   │   │   │   ├── code-generator.ts     # Generate reusable scraper scripts
│   │   │   │   └── quality-scorer.ts     # Confidence score calculator
│   │   │   ├── classifier/
│   │   │   │   ├── request-classifier.ts # URL analysis + HEAD probe
│   │   │   │   └── domain-strategy.ts    # Redis domain strategy cache
│   │   │   └── delivery/
│   │   │       ├── webhook.ts            # HMAC-signed webhook sender
│   │   │       └── sse-emitter.ts        # SSE stream emitter
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── dashboard/              # Next.js 15 admin dashboard
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx            # Landing / login
│       │   │   ├── dashboard/
│       │   │   │   ├── page.tsx        # Overview: usage charts, costs
│       │   │   │   ├── api-keys/
│       │   │   │   │   └── page.tsx    # API key management
│       │   │   │   ├── usage/
│       │   │   │   │   └── page.tsx    # Detailed usage analytics
│       │   │   │   ├── logs/
│       │   │   │   │   └── page.tsx    # Request logs + debugging
│       │   │   │   ├── playground/
│       │   │   │   │   └── page.tsx    # Interactive API tester
│       │   │   │   └── settings/
│       │   │   │       └── page.tsx    # Account + billing
│       │   │   └── api/               # Next.js API routes (auth, billing hooks)
│       │   ├── components/
│       │   ├── lib/
│       │   └── styles/
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── shared/                 # Shared types, constants, utilities
│   │   ├── src/
│   │   │   ├── types.ts        # All TypeScript interfaces
│   │   │   ├── constants.ts    # Queue names, tier names, defaults
│   │   │   ├── errors.ts       # Custom error classes
│   │   │   └── utils.ts        # Shared utility functions
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── sdk/                    # Node.js SDK for customers
│       ├── src/
│       │   ├── client.ts       # ScrapeForge client class
│       │   ├── types.ts        # Public-facing types
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
│
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.api
│   │   ├── Dockerfile.worker
│   │   └── Dockerfile.dashboard
│   ├── docker-compose.yml      # Full local stack
│   ├── docker-compose.prod.yml # Production overrides
│   ├── nginx/
│   │   └── nginx.conf          # Reverse proxy config
│   └── scripts/
│       ├── setup.sh            # Server provisioning script
│       ├── deploy.sh           # Deployment script
│       └── backup.sh           # Database backup script
│
├── docs/
│   ├── openapi.yaml            # OpenAPI 3.1 spec
│   └── README.md
│
├── tests/
│   ├── integration/
│   │   ├── scrape.test.ts
│   │   ├── crawl.test.ts
│   │   └── extract.test.ts
│   └── load/
│       └── k6-load-test.js     # k6 load testing script
│
├── turbo.json                  # Turborepo config
├── package.json                # Root workspace
├── tsconfig.base.json          # Shared TypeScript config
├── .env.example
├── .gitignore
└── README.md
```

---

## Phase 1 — Foundation (Week 1-2)

### Goal
Set up the monorepo, database schemas, Redis connection, API server with authentication, and the BullMQ job queue. At the end of this phase, you can send an authenticated POST request to `/v1/scrape`, it enqueues a job to Redis, and you can observe the job in the queue. No actual scraping happens yet.

### Prerequisites
- Node.js 20 LTS installed
- Docker and Docker Compose installed
- A code editor with TypeScript support
- Git initialized

### Step 1.1 — Initialize the monorepo

```bash
mkdir scrapeforge && cd scrapeforge
git init

# Initialize root package.json with workspaces
npm init -y
```

Edit `package.json` to:
```json
{
  "name": "scrapeforge",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev:api": "cd apps/api && npm run dev",
    "dev:worker": "cd apps/worker && npm run dev",
    "dev:dashboard": "cd apps/dashboard && npm run dev",
    "build": "turbo run build",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0"
  }
}
```

Create the directory skeleton:
```bash
mkdir -p apps/api/src/{routes,middleware,schemas,plugins}
mkdir -p apps/worker/src/{processors,engine,browser,proxy,extraction,classifier,delivery}
mkdir -p apps/dashboard/src
mkdir -p packages/shared/src
mkdir -p packages/sdk/src
mkdir -p infra/{docker,nginx,scripts}
mkdir -p tests/{integration,load}
mkdir -p docs
```

Create `tsconfig.base.json` at root:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### Step 1.2 — Set up Docker Compose for local development

Create `infra/docker-compose.yml`:
```yaml
version: "3.9"
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: scrapeforge
      POSTGRES_USER: scrapeforge
      POSTGRES_PASSWORD: localdev123
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U scrapeforge"]
      interval: 10s
      timeout: 3s
      retries: 3

volumes:
  redis-data:
  pg-data:
```

Create `infra/init.sql` — the complete database schema:
```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    password_hash VARCHAR(255),
    plan VARCHAR(50) DEFAULT 'free',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API keys table
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    key_prefix VARCHAR(12) NOT NULL,       -- First 12 chars for display: "sf_live_abc1..."
    name VARCHAR(255) DEFAULT 'Default',
    is_active BOOLEAN DEFAULT true,
    rate_limit_per_minute INTEGER DEFAULT 60,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Request logs table (partitioned by month for performance)
CREATE TABLE request_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    api_key_id UUID REFERENCES api_keys(id),
    job_id VARCHAR(255),
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    method VARCHAR(10) DEFAULT 'scrape',   -- scrape, crawl, extract, batch
    tier_used SMALLINT,                     -- 1, 2, 3, 4
    proxy_tier VARCHAR(20),                 -- datacenter, residential, mobile
    status VARCHAR(20) NOT NULL,            -- queued, processing, completed, failed
    status_code INTEGER,
    latency_ms INTEGER,
    cost_breakdown JSONB DEFAULT '{}',      -- { compute, proxy, captcha, llm }
    total_cost DECIMAL(10, 6),
    quality_score DECIMAL(3, 2),            -- 0.00 to 1.00
    cached BOOLEAN DEFAULT false,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_logs_user ON request_logs(user_id);
CREATE INDEX idx_logs_domain ON request_logs(domain);
CREATE INDEX idx_logs_created ON request_logs(created_at);
CREATE INDEX idx_logs_status ON request_logs(status);

-- Usage aggregation table (updated hourly by background job)
CREATE TABLE usage_daily (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    date DATE NOT NULL,
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    cached_requests INTEGER DEFAULT 0,
    tier1_requests INTEGER DEFAULT 0,
    tier2_requests INTEGER DEFAULT 0,
    tier3_requests INTEGER DEFAULT 0,
    tier4_requests INTEGER DEFAULT 0,
    total_cost DECIMAL(10, 4) DEFAULT 0,
    avg_latency_ms INTEGER DEFAULT 0,
    avg_quality_score DECIMAL(3, 2),
    UNIQUE(user_id, date)
);
CREATE INDEX idx_usage_user_date ON usage_daily(user_id, date);

-- Domain strategy cache (mirrors Redis, for analytics)
CREATE TABLE domain_strategies (
    domain VARCHAR(255) PRIMARY KEY,
    tier SMALLINT NOT NULL,
    proxy_tier VARCHAR(20),
    success_rate DECIMAL(5, 2),
    avg_latency_ms INTEGER,
    sample_size INTEGER DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

Start the services:
```bash
cd infra && docker compose up -d
```

### Step 1.3 — Build the shared types package

Create `packages/shared/package.json`:
```json
{
  "name": "@scrapeforge/shared",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  }
}
```

Create `packages/shared/src/types.ts`:
```typescript
// === Job Types ===
export interface ScrapeJobData {
  jobId: string;
  userId: string;
  apiKeyId: string;
  url: string;
  options: ScrapeOptions;
  priority: 1 | 2 | 3 | 4;       // 1=realtime, 2=standard, 3=batch, 4=background
  createdAt: string;
}

export interface ScrapeOptions {
  formats?: OutputFormat[];        // Which formats to return
  waitFor?: string;                // CSS selector to wait for
  timeout?: number;                // Max time in ms (default 30000)
  proxy?: ProxyPreference;
  headers?: Record<string, string>;
  cookies?: CookieInput[];
  screenshot?: boolean;
  mobile?: boolean;
  blockResources?: boolean;        // Block images/fonts/ads (default true)
  cacheTtl?: number;               // Cache TTL in seconds (0 = no cache)
  webhookUrl?: string;             // Deliver result via webhook
  extractSchema?: Record<string, unknown>;  // JSON schema for AI extraction
}

export type OutputFormat = 'html' | 'markdown' | 'text' | 'screenshot' | 'json';

export type ProxyPreference = 'none' | 'datacenter' | 'residential' | 'mobile' | 'auto';

export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

// === Result Types ===
export interface ScrapeResult {
  jobId: string;
  url: string;
  status: 'completed' | 'failed';
  statusCode?: number;
  content: {
    html?: string;
    markdown?: string;
    text?: string;
    screenshot?: string;           // Base64 PNG
    json?: Record<string, unknown>; // AI-extracted structured data
  };
  metadata: {
    tierUsed: number;
    proxyTier: string;
    latencyMs: number;
    cached: boolean;
    qualityScore: number;          // 0.0 - 1.0
    costBreakdown: CostBreakdown;
  };
  error?: string;
}

export interface CostBreakdown {
  compute: number;
  proxy: number;
  captcha: number;
  llm: number;
  total: number;
}

// === Domain Strategy ===
export interface DomainStrategy {
  tier: 1 | 2 | 3 | 4;
  proxyTier: 'datacenter' | 'residential' | 'mobile';
  successRate: number;
  avgLatencyMs: number;
  sampleSize: number;
  lastUpdated: string;
}

// === Proxy Types ===
export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: 'http' | 'https' | 'socks5';
  provider: string;
  tier: 'datacenter' | 'residential' | 'mobile';
  country?: string;
}

export interface ProxyScore {
  proxyId: string;
  successes: number;
  failures: number;
  avgLatency: number;
  lastUsed: string;
  domainScores: Record<string, { successes: number; failures: number }>;
}

// === Queue Constants ===
export const QUEUE_NAMES = {
  SCRAPE_REALTIME: 'scrape:realtime',
  SCRAPE_STANDARD: 'scrape:standard',
  SCRAPE_BATCH: 'scrape:batch',
  SCRAPE_BACKGROUND: 'scrape:background',
} as const;

export const QUEUE_CONFIG = {
  [QUEUE_NAMES.SCRAPE_REALTIME]:   { priority: 1, timeout: 30_000 },
  [QUEUE_NAMES.SCRAPE_STANDARD]:   { priority: 2, timeout: 60_000 },
  [QUEUE_NAMES.SCRAPE_BATCH]:      { priority: 3, timeout: 300_000 },
  [QUEUE_NAMES.SCRAPE_BACKGROUND]: { priority: 4, timeout: 1_800_000 },
} as const;

// === API Key Format ===
// Format: sf_live_<32 random chars>  (total 40 chars)
// Stored as: SHA-256 hash of the full key
// Display as: sf_live_abc1...xyz9 (prefix + last 4)
export const API_KEY_PREFIX = 'sf_live_';
```

Create `packages/shared/src/index.ts`:
```typescript
export * from './types.js';
```

### Step 1.4 — Build the API server

Create `apps/api/package.json`:
```json
{
  "name": "@scrapeforge/api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cors": "^11.0.0",
    "@fastify/rate-limit": "^10.2.0",
    "@fastify/swagger": "^9.4.0",
    "@fastify/swagger-ui": "^5.2.0",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.0",
    "pg": "^8.13.0",
    "zod": "^3.24.0",
    "nanoid": "^5.0.0",
    "@scrapeforge/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0"
  }
}
```

Create `apps/api/src/server.ts`:
```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@scrapeforge/shared';
import { scrapeRoutes } from './routes/scrape.js';
import { healthRoutes } from './routes/health.js';
import { statusRoutes } from './routes/status.js';
import { authMiddleware } from './middleware/auth.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
  requestTimeout: 35_000,
  bodyLimit: 1_048_576,  // 1MB
});

// --- Connections ---
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,  // Required by BullMQ
  enableReadyCheck: false,
});

const pg = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://scrapeforge:localdev123@localhost:5432/scrapeforge',
  max: 20,
  idleTimeoutMillis: 30_000,
});

// --- BullMQ Queues (producer side) ---
const connection = { host: 'localhost', port: 6379 };
const queues = {
  realtime:   new Queue(QUEUE_NAMES.SCRAPE_REALTIME,   { connection }),
  standard:   new Queue(QUEUE_NAMES.SCRAPE_STANDARD,   { connection }),
  batch:      new Queue(QUEUE_NAMES.SCRAPE_BATCH,      { connection }),
  background: new Queue(QUEUE_NAMES.SCRAPE_BACKGROUND, { connection }),
};

// --- Decorate Fastify with shared instances ---
app.decorate('redis', redis);
app.decorate('pg', pg);
app.decorate('queues', queues);

// --- Plugins ---
await app.register(cors, { origin: true });

// --- Middleware ---
app.addHook('onRequest', authMiddleware);

// --- Routes ---
app.register(healthRoutes);
app.register(scrapeRoutes, { prefix: '/v1' });
app.register(statusRoutes, { prefix: '/v1' });

// --- Start ---
const PORT = parseInt(process.env.PORT || '3000');
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`API server running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

Create `apps/api/src/middleware/auth.ts`:
```typescript
import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

// Routes that skip authentication
const PUBLIC_ROUTES = ['/health', '/docs', '/docs/json'];

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (PUBLIC_ROUTES.some(r => request.url.startsWith(r))) return;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: 'Missing API key. Pass it as: Authorization: Bearer sf_live_...',
    });
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey.startsWith('sf_live_')) {
    return reply.status(401).send({ error: 'Invalid API key format.' });
  }

  // Hash the key and look it up in PostgreSQL
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const pg = (request.server as any).pg;

  const result = await pg.query(
    `SELECT ak.id, ak.user_id, ak.rate_limit_per_minute, ak.is_active, u.plan
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     WHERE ak.key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0 || !result.rows[0].is_active) {
    return reply.status(401).send({ error: 'Invalid or deactivated API key.' });
  }

  const keyData = result.rows[0];
  // Attach user context to request for downstream use
  (request as any).user = {
    userId: keyData.user_id,
    apiKeyId: keyData.id,
    plan: keyData.plan,
    rateLimit: keyData.rate_limit_per_minute,
  };

  // Update last_used_at (fire-and-forget, don't block the request)
  pg.query(
    'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
    [keyData.id]
  ).catch(() => {});
}
```

Create `apps/api/src/routes/scrape.ts`:
```typescript
import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ScrapeJobData, QUEUE_NAMES } from '@scrapeforge/shared';

const ScrapeRequestSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  formats: z.array(z.enum(['html', 'markdown', 'text', 'screenshot', 'json']))
    .default(['markdown']),
  waitFor: z.string().optional(),
  timeout: z.number().min(1000).max(60000).default(30000),
  proxy: z.enum(['none', 'datacenter', 'residential', 'mobile', 'auto']).default('auto'),
  headers: z.record(z.string()).optional(),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
  })).optional(),
  screenshot: z.boolean().default(false),
  mobile: z.boolean().default(false),
  blockResources: z.boolean().default(true),
  cacheTtl: z.number().min(0).max(2592000).default(3600),
  webhookUrl: z.string().url().optional(),
  extractSchema: z.record(z.unknown()).optional(),
});

export async function scrapeRoutes(app: FastifyInstance) {
  app.post('/scrape', async (request, reply) => {
    // 1. Validate request body
    const parseResult = ScrapeRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
    }
    const body = parseResult.data;
    const user = (request as any).user;

    // 2. Check cache first
    const redis = (app as any).redis;
    const cacheKey = `cache:${createCacheKey(body.url, body)}`;
    if (body.cacheTtl > 0) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return reply.status(200).send({
          ...JSON.parse(cached),
          metadata: { ...JSON.parse(cached).metadata, cached: true },
        });
      }
    }

    // 3. Create job
    const jobId = `job_${nanoid(16)}`;
    const jobData: ScrapeJobData = {
      jobId,
      userId: user.userId,
      apiKeyId: user.apiKeyId,
      url: body.url,
      options: body,
      priority: body.webhookUrl ? 2 : 1,  // Sync = priority 1, async = priority 2
      createdAt: new Date().toISOString(),
    };

    // 4. Enqueue to BullMQ
    const queueName = body.webhookUrl
      ? QUEUE_NAMES.SCRAPE_STANDARD
      : QUEUE_NAMES.SCRAPE_REALTIME;
    const queue = (app as any).queues[body.webhookUrl ? 'standard' : 'realtime'];

    const job = await queue.add(jobId, jobData, {
      jobId,
      priority: jobData.priority,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },     // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 },        // Keep failed jobs for 24 hours
    });

    // 5. If sync (no webhook), wait for result
    if (!body.webhookUrl) {
      const result = await job.waitUntilFinished(
        (app as any).queues.realtime.events,
        body.timeout
      );
      return reply.status(200).send(result);
    }

    // 6. If async (has webhook), return job ID immediately
    return reply.status(202).send({
      jobId,
      status: 'queued',
      statusUrl: `/v1/status/${jobId}`,
    });
  });
}

function createCacheKey(url: string, options: any): string {
  const crypto = require('node:crypto');
  const payload = JSON.stringify({ url, formats: options.formats, proxy: options.proxy });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
```

Create `apps/api/src/routes/status.ts`:
```typescript
import { FastifyInstance } from 'fastify';

export async function statusRoutes(app: FastifyInstance) {
  app.get('/status/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const redis = (app as any).redis;

    // Check all queues for the job
    const result = await redis.get(`result:${jobId}`);
    if (result) {
      return reply.send({ status: 'completed', data: JSON.parse(result) });
    }

    const progress = await redis.get(`progress:${jobId}`);
    if (progress) {
      return reply.send({ status: 'processing', progress: JSON.parse(progress) });
    }

    return reply.status(404).send({ error: 'Job not found' });
  });
}
```

Create `apps/api/src/routes/health.ts`:
```typescript
import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (request, reply) => {
    const redis = (app as any).redis;
    const pg = (app as any).pg;

    try {
      await redis.ping();
      await pg.query('SELECT 1');
      return reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (error) {
      return reply.status(503).send({ status: 'unhealthy', error: String(error) });
    }
  });
}
```

### Step 1.5 — Generate an API key for testing

Create a one-time script `infra/scripts/seed.ts`:
```typescript
import crypto from 'node:crypto';
import { Pool } from 'pg';

const pg = new Pool({
  connectionString: 'postgres://scrapeforge:localdev123@localhost:5432/scrapeforge',
});

async function seed() {
  // Create test user
  const userResult = await pg.query(
    `INSERT INTO users (email, name, plan)
     VALUES ('dev@scrapeforge.io', 'Dev User', 'pro')
     RETURNING id`
  );
  const userId = userResult.rows[0].id;

  // Generate API key
  const rawKey = `sf_live_${crypto.randomBytes(16).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12);

  await pg.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, rate_limit_per_minute)
     VALUES ($1, $2, $3, 'Dev Key', 120)`,
    [userId, keyHash, keyPrefix]
  );

  console.log('='.repeat(60));
  console.log('TEST API KEY (save this, it will not be shown again):');
  console.log(rawKey);
  console.log('='.repeat(60));

  await pg.end();
}

seed().catch(console.error);
```

Run it:
```bash
npx tsx infra/scripts/seed.ts
```

### Acceptance criteria for Phase 1

1. `docker compose up -d` starts Redis and PostgreSQL without errors
2. `npm run dev:api` starts the Fastify server on port 3000
3. `curl localhost:3000/health` returns `{ "status": "healthy" }`
4. `curl -X POST localhost:3000/v1/scrape -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" -d '{"url":"https://example.com"}'` enqueues a job (will timeout since no worker yet — that is expected)
5. A request without an API key returns 401
6. A request with an invalid URL returns 400 with validation errors

---

## Phase 2 — Scraping Engine Core (Week 2-3)

### Goal
Build the 4-tier rendering engine. At the end of this phase, a `/v1/scrape` request successfully fetches a page using the cheapest working tier, returns clean HTML/Markdown, and stores the result in Redis cache.

### Step 2.1 — Install worker dependencies

Create `apps/worker/package.json`:
```json
{
  "name": "@scrapeforge/worker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/worker.ts",
    "build": "tsc",
    "start": "node dist/worker.js"
  },
  "dependencies": {
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.0",
    "pg": "^8.13.0",
    "impit": "^1.0.0",
    "patchright": "^1.49.0",
    "cheerio": "^1.0.0",
    "@mozilla/readability": "^0.5.0",
    "jsdom": "^25.0.0",
    "linkedom": "^0.18.0",
    "turndown": "^7.2.0",
    "@scrapeforge/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/jsdom": "^21.0.0",
    "@types/turndown": "^5.0.0"
  }
}
```

Install browser binaries:
```bash
cd apps/worker
npx patchright install chromium
```

### Step 2.2 — Build Tier 1: HTTP fetcher with impit

Create `apps/worker/src/engine/tier1-http.ts`:
```typescript
import { fetch as impitFetch } from 'impit';

export interface FetchResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  latencyMs: number;
}

export async function tier1Fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    proxy?: string;
  } = {}
): Promise<FetchResult> {
  const start = performance.now();

  const response = await impitFetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...options.headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeout || 15_000),
    // impit automatically generates browser-like TLS fingerprints
    // No need for User-Agent — impit handles it
  });

  const html = await response.text();
  const latencyMs = Math.round(performance.now() - start);

  return {
    html,
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    latencyMs,
  };
}

/**
 * Validation: Check if the HTTP response contains real content.
 * Returns false if the page is a bot-detection challenge page.
 */
export function isValidContent(html: string, statusCode: number): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return false;
  if (html.length < 500) return false;

  // Known bot-detection indicators
  const blockIndicators = [
    'cf-browser-verification',  // Cloudflare challenge
    'challenge-platform',       // Cloudflare Turnstile
    'ddos-protection',          // Generic DDOS protection page
    'captcha-delivery',         // CAPTCHA page
    'access denied',            // Generic block
    'please verify you are human',
    'just a moment',            // Cloudflare "Just a moment..."
  ];

  const lowerHtml = html.toLowerCase();
  return !blockIndicators.some(indicator => lowerHtml.includes(indicator));
}
```

### Step 2.3 — Build Tier 4: Playwright/Patchright browser

Create `apps/worker/src/engine/tier4-browser.ts`:
```typescript
import { chromium, BrowserContext, Page } from 'patchright';

// Resources to block for bandwidth savings
const BLOCKED_RESOURCE_TYPES = new Set([
  'image', 'media', 'font', 'manifest', 'prefetch',
]);

// Domains to block (ads, analytics, tracking)
const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com',
  'facebook.net', 'doubleclick.net', 'hotjar.com',
  'segment.com', 'mixpanel.com', 'amplitude.com',
];

export async function tier4Fetch(
  url: string,
  context: BrowserContext,
  options: {
    waitFor?: string;
    timeout?: number;
    blockResources?: boolean;
    mobile?: boolean;
    screenshot?: boolean;
  } = {}
): Promise<{
  html: string;
  statusCode: number;
  screenshot?: string;
  latencyMs: number;
}> {
  const start = performance.now();
  const page = await context.newPage();

  try {
    // Block unnecessary resources (saves ~86% bandwidth)
    if (options.blockResources !== false) {
      await page.route('**/*', (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const url = request.url();

        if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
          return route.abort();
        }
        if (BLOCKED_DOMAINS.some(d => url.includes(d))) {
          return route.abort();
        }
        return route.continue();
      });
    }

    // Navigate
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout || 30_000,
    });

    // Wait for specific selector if requested
    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, {
        timeout: Math.min(options.timeout || 10_000, 10_000),
      });
    } else {
      // Default: wait for network to settle
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    // Extract content
    const html = await page.content();
    const statusCode = response?.status() || 200;

    // Optional screenshot
    let screenshot: string | undefined;
    if (options.screenshot) {
      const buffer = await page.screenshot({
        fullPage: true,
        type: 'png',
      });
      screenshot = buffer.toString('base64');
    }

    return {
      html,
      statusCode,
      screenshot,
      latencyMs: Math.round(performance.now() - start),
    };
  } finally {
    await page.close();
  }
}
```

### Step 2.4 — Build the Smart Router

Create `apps/worker/src/engine/router.ts`:
```typescript
import { Redis } from 'ioredis';
import { tier1Fetch, isValidContent } from './tier1-http.js';
import { tier4Fetch } from './tier4-browser.js';
import { ScrapeOptions, DomainStrategy } from '@scrapeforge/shared';
import { BrowserContext } from 'patchright';

export interface RouterResult {
  html: string;
  statusCode: number;
  tierUsed: number;
  screenshot?: string;
  latencyMs: number;
}

export class SmartRouter {
  constructor(
    private redis: Redis,
    private getBrowserContext: () => Promise<BrowserContext>,
    private releaseBrowserContext: (ctx: BrowserContext) => void,
  ) {}

  async route(url: string, options: ScrapeOptions): Promise<RouterResult> {
    const domain = new URL(url).hostname;

    // 1. Check domain strategy cache
    const cached = await this.getDomainStrategy(domain);
    if (cached && cached.successRate > 0.8) {
      return this.executeAtTier(cached.tier, url, options);
    }

    // 2. No cache or low confidence — start from Tier 1 and escalate
    return this.escalate(url, options, domain);
  }

  private async escalate(
    url: string,
    options: ScrapeOptions,
    domain: string
  ): Promise<RouterResult> {
    // Try Tier 1: HTTP fetch
    try {
      const result = await tier1Fetch(url, {
        headers: options.headers,
        timeout: Math.min(options.timeout || 15000, 15000),
      });
      if (isValidContent(result.html, result.statusCode)) {
        await this.updateDomainStrategy(domain, 1, true, result.latencyMs);
        return { ...result, tierUsed: 1 };
      }
    } catch (err) {
      // Tier 1 failed, continue to Tier 4
    }

    // Skip Tier 2 and 3 for now (add in Phase 3)
    // Try Tier 4: Full browser
    let context: BrowserContext | null = null;
    try {
      context = await this.getBrowserContext();
      const result = await tier4Fetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        mobile: options.mobile,
        screenshot: options.screenshot,
      });

      if (isValidContent(result.html, result.statusCode)) {
        await this.updateDomainStrategy(domain, 4, true, result.latencyMs);
        return { ...result, tierUsed: 4 };
      }

      await this.updateDomainStrategy(domain, 4, false, result.latencyMs);
      throw new Error(`All tiers failed for ${domain}`);
    } finally {
      if (context) this.releaseBrowserContext(context);
    }
  }

  private async executeAtTier(
    tier: number,
    url: string,
    options: ScrapeOptions
  ): Promise<RouterResult> {
    if (tier <= 2) {
      const result = await tier1Fetch(url, { headers: options.headers });
      if (isValidContent(result.html, result.statusCode)) {
        return { ...result, tierUsed: tier };
      }
      // If cached tier fails, escalate
      return this.escalate(url, options, new URL(url).hostname);
    }

    // Tier 3 or 4 — use browser
    const context = await this.getBrowserContext();
    try {
      const result = await tier4Fetch(url, context, options);
      return { ...result, tierUsed: tier };
    } finally {
      this.releaseBrowserContext(context);
    }
  }

  private async getDomainStrategy(domain: string): Promise<DomainStrategy | null> {
    const data = await this.redis.get(`domain:${domain}`);
    return data ? JSON.parse(data) : null;
  }

  private async updateDomainStrategy(
    domain: string,
    tier: number,
    success: boolean,
    latencyMs: number
  ): Promise<void> {
    const key = `domain:${domain}`;
    const existing = await this.getDomainStrategy(domain);

    const sampleSize = (existing?.sampleSize || 0) + 1;
    const successCount = (existing ? existing.successRate * existing.sampleSize : 0) + (success ? 1 : 0);

    const strategy: DomainStrategy = {
      tier: (success ? tier : Math.min(tier + 1, 4)) as 1 | 2 | 3 | 4,
      proxyTier: existing?.proxyTier || 'datacenter',
      successRate: successCount / sampleSize,
      avgLatencyMs: existing
        ? Math.round((existing.avgLatencyMs * (sampleSize - 1) + latencyMs) / sampleSize)
        : latencyMs,
      sampleSize,
      lastUpdated: new Date().toISOString(),
    };

    await this.redis.set(key, JSON.stringify(strategy), 'EX', 86400); // 24h TTL
  }
}
```

### Step 2.5 — Build the extraction pipeline

Create `apps/worker/src/extraction/pipeline.ts`:
```typescript
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { OutputFormat } from '@scrapeforge/shared';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export interface ExtractionResult {
  html?: string;
  markdown?: string;
  text?: string;
  json?: Record<string, unknown>;
}

export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[]
): Promise<ExtractionResult> {
  const result: ExtractionResult = {};

  if (formats.includes('html')) {
    result.html = cleanHtml(rawHtml);
  }

  if (formats.includes('markdown') || formats.includes('text')) {
    const article = extractArticle(rawHtml, url);
    if (formats.includes('markdown')) {
      result.markdown = article
        ? turndown.turndown(article.content)
        : turndown.turndown(cleanHtml(rawHtml));
    }
    if (formats.includes('text')) {
      result.text = article?.textContent || extractPlainText(rawHtml);
    }
  }

  // JSON extraction (AI-powered) is added in Phase 4
  return result;
}

function cleanHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove noise elements
  $('script, style, noscript, iframe, svg, link[rel="stylesheet"]').remove();
  $('nav, footer, header, aside, .ad, .ads, .advertisement').remove();
  $('[class*="cookie"], [class*="banner"], [class*="popup"]').remove();
  $('[id*="cookie"], [id*="banner"], [id*="popup"]').remove();

  return $.html();
}

function extractArticle(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  return reader.parse();
}

function extractPlainText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}
```

### Step 2.6 — Build the quality scorer

Create `apps/worker/src/extraction/quality-scorer.ts`:
```typescript
export interface QualityReport {
  score: number;        // 0.0 - 1.0
  signals: string[];    // Human-readable explanation
}

export function calculateQualityScore(
  html: string,
  statusCode: number,
  tierUsed: number,
  latencyMs: number
): QualityReport {
  const signals: string[] = [];
  let score = 1.0;

  // 1. Status code penalty
  if (statusCode !== 200) {
    score -= 0.3;
    signals.push(`Non-200 status code: ${statusCode}`);
  }

  // 2. Content length check
  if (html.length < 1000) {
    score -= 0.2;
    signals.push('Very short content (possible block page)');
  }

  // 3. Bot detection page indicators
  const botIndicators = [
    'captcha', 'challenge', 'verify you are human',
    'access denied', 'blocked', 'rate limit',
  ];
  const lowerHtml = html.toLowerCase();
  const matchedIndicators = botIndicators.filter(i => lowerHtml.includes(i));
  if (matchedIndicators.length > 0) {
    score -= 0.3 * matchedIndicators.length;
    signals.push(`Bot detection indicators found: ${matchedIndicators.join(', ')}`);
  }

  // 4. Content diversity (does it have varied HTML tags?)
  const tagCounts = (html.match(/<(p|h[1-6]|li|td|article|section|div)[>\s]/gi) || []).length;
  if (tagCounts < 3) {
    score -= 0.1;
    signals.push('Low content diversity (few semantic HTML tags)');
  }

  // 5. Latency penalty for very slow responses
  if (latencyMs > 15000) {
    score -= 0.1;
    signals.push('High latency response');
  }

  score = Math.max(0, Math.min(1, score));
  if (score >= 0.8) signals.push('Content appears valid');

  return { score: Math.round(score * 100) / 100, signals };
}
```

### Step 2.7 — Build the browser pool manager

Create `apps/worker/src/browser/pool.ts`:
```typescript
import { chromium, Browser, BrowserContext } from 'patchright';

interface PooledContext {
  context: BrowserContext;
  useCount: number;
  createdAt: number;
  inUse: boolean;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts: PooledContext[] = [];
  private waitQueue: Array<(ctx: BrowserContext) => void> = [];

  constructor(
    private maxContexts: number = 5,
    private maxUsesPerContext: number = 100,
    private maxAgeMs: number = 30 * 60 * 1000, // 30 minutes
  ) {}

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    // Pre-warm contexts
    const warmCount = Math.min(3, this.maxContexts);
    for (let i = 0; i < warmCount; i++) {
      await this.createContext();
    }
    console.log(`Browser pool initialized with ${warmCount} contexts (max: ${this.maxContexts})`);
  }

  async acquire(): Promise<BrowserContext> {
    // Find an idle context
    const idle = this.contexts.find(c => !c.inUse && !this.isExpired(c));
    if (idle) {
      idle.inUse = true;
      idle.useCount++;
      return idle.context;
    }

    // Create new if under limit
    if (this.contexts.length < this.maxContexts) {
      const pooled = await this.createContext();
      pooled.inUse = true;
      pooled.useCount++;
      return pooled.context;
    }

    // Wait in queue
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(context: BrowserContext): void {
    const pooled = this.contexts.find(c => c.context === context);
    if (!pooled) return;

    pooled.inUse = false;

    // Recycle if expired
    if (this.isExpired(pooled)) {
      this.recycleContext(pooled);
      return;
    }

    // Clear state for reuse
    context.clearCookies().catch(() => {});

    // Serve waiting requests
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      pooled.inUse = true;
      pooled.useCount++;
      next(pooled.context);
    }
  }

  private isExpired(pooled: PooledContext): boolean {
    return (
      pooled.useCount >= this.maxUsesPerContext ||
      Date.now() - pooled.createdAt > this.maxAgeMs
    );
  }

  private async createContext(): Promise<PooledContext> {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: undefined,  // Patchright handles UA automatically
    });

    const pooled: PooledContext = {
      context,
      useCount: 0,
      createdAt: Date.now(),
      inUse: false,
    };
    this.contexts.push(pooled);
    return pooled;
  }

  private async recycleContext(pooled: PooledContext): Promise<void> {
    const index = this.contexts.indexOf(pooled);
    if (index > -1) this.contexts.splice(index, 1);
    await pooled.context.close().catch(() => {});

    // Replace with fresh context
    const fresh = await this.createContext();

    // Serve waiting if any
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      fresh.inUse = true;
      fresh.useCount++;
      next(fresh.context);
    }
  }

  async shutdown(): Promise<void> {
    for (const pooled of this.contexts) {
      await pooled.context.close().catch(() => {});
    }
    await this.browser?.close();
    this.contexts = [];
  }

  stats() {
    return {
      total: this.contexts.length,
      inUse: this.contexts.filter(c => c.inUse).length,
      idle: this.contexts.filter(c => !c.inUse).length,
      waiting: this.waitQueue.length,
    };
  }
}
```

### Step 2.8 — Build the main worker process

Create `apps/worker/src/worker.ts`:
```typescript
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { ScrapeJobData, ScrapeResult, QUEUE_NAMES } from '@scrapeforge/shared';
import { SmartRouter } from './engine/router.js';
import { BrowserPool } from './browser/pool.js';
import { extractContent } from './extraction/pipeline.js';
import { calculateQualityScore } from './extraction/quality-scorer.js';

// --- Connections ---
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const pg = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://scrapeforge:localdev123@localhost:5432/scrapeforge',
});

// --- Browser Pool ---
const browserPool = new BrowserPool(
  parseInt(process.env.MAX_BROWSER_CONTEXTS || '5'),
  100,    // Max uses per context
  30 * 60 * 1000  // 30 min max age
);
await browserPool.initialize();

// --- Smart Router ---
const router = new SmartRouter(
  redis,
  () => browserPool.acquire(),
  (ctx) => browserPool.release(ctx),
);

// --- Job Processor ---
async function processScrapeJob(job: Job<ScrapeJobData>): Promise<ScrapeResult> {
  const { jobId, url, options, userId, apiKeyId } = job.data;

  console.log(`[${jobId}] Processing: ${url}`);
  await job.updateProgress(10);

  try {
    // 1. Route to the best tier
    const routerResult = await router.route(url, options);
    await job.updateProgress(50);

    // 2. Extract content in requested formats
    const extracted = await extractContent(
      routerResult.html,
      url,
      options.formats || ['markdown']
    );
    await job.updateProgress(80);

    // 3. Calculate quality score
    const quality = calculateQualityScore(
      routerResult.html,
      routerResult.statusCode,
      routerResult.tierUsed,
      routerResult.latencyMs
    );

    // 4. Build result
    const result: ScrapeResult = {
      jobId,
      url,
      status: 'completed',
      statusCode: routerResult.statusCode,
      content: {
        ...extracted,
        screenshot: routerResult.screenshot,
      },
      metadata: {
        tierUsed: routerResult.tierUsed,
        proxyTier: 'none',
        latencyMs: routerResult.latencyMs,
        cached: false,
        qualityScore: quality.score,
        costBreakdown: {
          compute: routerResult.tierUsed <= 2 ? 0.00001 : 0.0005,
          proxy: 0,
          captcha: 0,
          llm: 0,
          total: routerResult.tierUsed <= 2 ? 0.00001 : 0.0005,
        },
      },
    };

    // 5. Cache the result
    if (options.cacheTtl && options.cacheTtl > 0) {
      const cacheKey = `cache:${createCacheKey(url, options)}`;
      await redis.set(cacheKey, JSON.stringify(result), 'EX', options.cacheTtl);
    }

    // 6. Store result for status polling
    await redis.set(`result:${jobId}`, JSON.stringify(result), 'EX', 3600);

    // 7. Log to PostgreSQL (fire-and-forget)
    logRequest(pg, {
      userId, apiKeyId, jobId, url,
      domain: new URL(url).hostname,
      tierUsed: routerResult.tierUsed,
      statusCode: routerResult.statusCode,
      latencyMs: routerResult.latencyMs,
      qualityScore: quality.score,
      totalCost: result.metadata.costBreakdown.total,
    }).catch(err => console.error('Log write failed:', err));

    await job.updateProgress(100);
    console.log(`[${jobId}] Completed in ${routerResult.latencyMs}ms (Tier ${routerResult.tierUsed})`);
    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${jobId}] Failed:`, errorMessage);

    const failResult: ScrapeResult = {
      jobId,
      url,
      status: 'failed',
      content: {},
      metadata: {
        tierUsed: 0,
        proxyTier: 'none',
        latencyMs: 0,
        cached: false,
        qualityScore: 0,
        costBreakdown: { compute: 0, proxy: 0, captcha: 0, llm: 0, total: 0 },
      },
      error: errorMessage,
    };

    await redis.set(`result:${jobId}`, JSON.stringify(failResult), 'EX', 3600);
    throw error;
  }
}

// --- Start Workers ---
const workerOptions = {
  connection: { host: 'localhost', port: 6379 },
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '3'),
};

// One worker per queue priority
for (const queueName of Object.values(QUEUE_NAMES)) {
  const worker = new Worker(queueName, processScrapeJob, workerOptions);

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  console.log(`Worker listening on queue: ${queueName}`);
}

// --- Graceful Shutdown ---
async function shutdown() {
  console.log('Shutting down workers...');
  await browserPool.shutdown();
  await redis.quit();
  await pg.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- Helpers ---
function createCacheKey(url: string, options: any): string {
  const crypto = await import('node:crypto');
  const payload = JSON.stringify({ url, formats: options.formats, proxy: options.proxy });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function logRequest(pg: Pool, data: any) {
  await pg.query(
    `INSERT INTO request_logs (user_id, api_key_id, job_id, url, domain, tier_used, status_code, latency_ms, quality_score, total_cost, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed')`,
    [data.userId, data.apiKeyId, data.jobId, data.url, data.domain, data.tierUsed, data.statusCode, data.latencyMs, data.qualityScore, data.totalCost]
  );
}
```

### Acceptance criteria for Phase 2

1. `npm run dev:worker` starts and logs "Browser pool initialized"
2. A scrape request for `https://example.com` returns clean Markdown within 2 seconds
3. A scrape request for a JS-rendered site (e.g., a React SPA) correctly escalates to Tier 4 and returns content
4. The domain strategy cache in Redis shows the correct tier for previously scraped domains (`redis-cli GET domain:example.com`)
5. Subsequent requests for the same domain use the cached tier (check logs)
6. Quality score is returned in every response metadata
7. Results are cached in Redis and served on repeat requests

---

## Phase 3 — Proxy, Anti-Detection, and Tier 2/3 (Week 3-4)

### Goal
Add proxy rotation, TLS impersonation (Tier 2), Lightpanda (Tier 3), Camoufox stealth (Tier 4+), and fingerprint rotation. After this phase, the system can scrape protected sites behind Cloudflare and similar anti-bot systems.

### Step 3.1 — Proxy manager

Create `apps/worker/src/proxy/manager.ts` — manages a pool of proxies from multiple providers. Implements the scoring algorithm: `score = (success_rate × 0.5) + (1/avg_latency × 0.3) + (uptime × 0.2)`. Tracks per-domain scores in Redis. Proxies below 70% success rate are demoted. Proxies above 95% are promoted.

**Proxy provider configuration** (create `apps/worker/src/proxy/providers.ts`):
- Tier A (datacenter): Configure IPRoyal and Webshare. Cost: $0.035/IP.
- Tier B (residential): Configure IPRoyal and Dataimpulse. Cost: $2-4/GB.
- Tier C (mobile): Configure Massive. Cost: $4-8/GB.

**Proxy selection flow:**
1. Check domain strategy cache → use cached proxy tier
2. If no cache → start with Tier A (datacenter)
3. If blocked (403/CAPTCHA) → escalate to Tier B
4. If still blocked → escalate to Tier C
5. Cache the successful proxy tier for this domain (24h TTL)

### Step 3.2 — Tier 2: TLS impersonation

Create `apps/worker/src/engine/tier2-tls.ts` — Python sidecar process running `curl_cffi` for sites that check TLS fingerprints (JA3/JA4). Communication via HTTP on a Unix socket. The sidecar accepts URL + options and returns HTML. Pool of 2-4 Python workers.

**Alternative:** Use `impit` with explicit browser impersonation profiles. impit supports Chrome, Safari, and Firefox TLS profiles out of the box. If impit handles the target domain successfully, skip the Python sidecar entirely.

### Step 3.3 — Tier 3: Lightpanda integration

Create `apps/worker/src/engine/tier3-light.ts` — connects to Lightpanda via CDP WebSocket (`wss://euwest.cloud.lightpanda.io` for cloud, or self-hosted binary). Falls back to Tier 4 if rendering fidelity issues detected.

**When to use Tier 3:** Sites that need JavaScript execution but not full Chrome rendering. Detectable by checking if the page returns an empty `<div id="root">` or similar SPA shell with Tier 1.

### Step 3.4 — Stealth browser with Camoufox

Create `apps/worker/src/engine/tier4-stealth.ts` — Firefox-based anti-detect browser for heavily protected sites (Cloudflare Enterprise, DataDome, PerimeterX). Uses Camoufox which spoofs 50+ fingerprint parameters at C++ level.

**When to use:** Only for domains where Tier 4 (Patchright/Chromium) fails. Domain strategy cache tracks which domains need stealth mode.

### Step 3.5 — Fingerprint rotation with BrowserForge

Create `apps/worker/src/browser/fingerprint.ts` — generates internally consistent fingerprints (matching OS, User-Agent, platform, fonts, timezone, screen resolution). Each browser context gets a unique fingerprint. Within a multi-page session, the same fingerprint is maintained.

### Acceptance criteria for Phase 3

1. Proxy manager rotates between datacenter proxies on each request
2. A scrape request for a Cloudflare-protected site succeeds with residential proxy fallback
3. Domain strategy cache stores the working proxy tier alongside the rendering tier
4. Tier 2 (TLS impersonation) handles sites that block standard HTTP clients
5. Tier 3 (Lightpanda) is measurably faster and uses less memory than Tier 4 for compatible sites
6. Browser fingerprints are unique per context and internally consistent

---

## Phase 4 — AI Extraction and Advanced Features (Week 4-5)

### Goal
Add LLM-powered structured data extraction, the code generation pattern for zero-cost repeated extraction, CAPTCHA solving, webhook delivery, and SSE streaming.

### Step 4.1 — AI extractor with tiered model routing

Create `apps/worker/src/extraction/ai-extractor.ts`:
- Accept a JSON schema (Zod-compatible) defining desired fields
- **Route 1 (cheapest):** Check if a pre-generated CSS/XPath scraper exists for this domain → run deterministic code
- **Route 2 (cheap):** Send pruned HTML (via `html-cleaner.ts`) + schema to Gemini 2.0 Flash-Lite ($0.075/M tokens)
- **Route 3 (standard):** Send to GPT-4.1 nano with prompt caching
- Return structured, validated JSON

### Step 4.2 — Code generation pattern

Create `apps/worker/src/extraction/code-generator.ts`:
- On first AI extraction for a domain+schema combo, ask the LLM to also generate a deterministic Cheerio/CSS selector script
- Store the generated script in Redis with the domain+schema as key
- On subsequent requests, execute the deterministic script (zero LLM cost)
- Monitor extraction quality; if score drops below 0.7, regenerate the script

### Step 4.3 — CAPTCHA solving integration

Create `apps/worker/src/engine/captcha-solver.ts`:
- Detect CAPTCHA type from page DOM (reCAPTCHA, hCaptcha, Cloudflare Turnstile)
- Integrate with CapSolver API for automated solving
- Budget: $0.003 per solve, track in cost breakdown

### Step 4.4 — Webhook delivery

Create `apps/worker/src/delivery/webhook.ts`:
- HMAC-SHA256 signed payloads
- Retry with exponential backoff (3 attempts)
- Include `X-ScrapeForge-Signature` header for verification

### Step 4.5 — SSE streaming

Create `apps/api/src/plugins/sse.ts`:
- Server-Sent Events endpoint at `GET /v1/scrape/stream`
- Stream partial results: `event: headers`, `event: content`, `event: extraction`, `event: complete`
- Client receives data incrementally as each processing stage completes

### Acceptance criteria for Phase 4

1. `/v1/extract` with a JSON schema returns clean, validated structured data
2. Second extraction request for the same domain+schema uses the cached script (no LLM call, verify in logs)
3. A CAPTCHA-protected page is solved and content extracted
4. Webhook delivery sends signed results to a test endpoint
5. SSE stream delivers incremental updates to a test client

---

## Phase 5 — Dashboard and Billing (Week 5-6)

### Goal
Build the Next.js 15 dashboard with the dark charcoal + amber design system, API key management, usage analytics, interactive playground, and Stripe metered billing.

### Step 5.1 — Next.js 15 dashboard setup

```bash
cd apps
npx create-next-app@latest dashboard --typescript --tailwind --app --src-dir
```

**Design system:** Dark charcoal (#1a1a1a) background, amber (#F59E0B) accents, Outfit font for headings, JetBrains Mono for code. This matches your existing `scrape-dashboard` design system.

### Step 5.2 — Dashboard pages

1. **Overview** (`/dashboard`) — Total requests today, success rate, avg latency, cost this month. Recharts line chart for requests over time.
2. **API Keys** (`/dashboard/api-keys`) — Create, revoke, rename keys. Show prefix + last 4 chars. Copy full key only on creation.
3. **Usage** (`/dashboard/usage`) — Per-day breakdown: requests by tier, cost breakdown, quality score distribution. Date range picker.
4. **Logs** (`/dashboard/logs`) — Searchable request log table with filters (status, domain, tier, date). Click to expand full request/response details.
5. **Playground** (`/dashboard/playground`) — Interactive API tester. Enter URL, select options, see live results with formatted output.
6. **Settings** (`/dashboard/settings`) — Account info, plan details, billing portal link, webhook configuration.

### Step 5.3 — Stripe integration

- **Subscription plans:** Free, Starter ($29), Pro ($99), Business ($249)
- **Metered billing:** Track usage per API key, report to Stripe's usage records API hourly
- **Billing portal:** Use Stripe Customer Portal for plan changes, invoices, payment methods

### Acceptance criteria for Phase 5

1. Dashboard loads with real data from PostgreSQL
2. API keys can be created, displayed (prefix only), and revoked
3. Usage charts show accurate per-day metrics
4. Playground successfully makes scrape requests and displays results
5. Stripe checkout flow works for upgrading from Free to Starter
6. Metered usage is recorded and appears on Stripe invoices

---

## Phase 6 — Monitoring, Hardening, and Documentation (Week 6-7)

### Goal
Production-grade observability with Prometheus + Grafana, load testing, security audit, and comprehensive API documentation.

### Step 6.1 — Prometheus metrics

Expose from both API and worker processes:
- `scrape_requests_total` (counter, labels: tier, status, domain)
- `scrape_duration_seconds` (histogram, labels: tier)
- `scrape_cost_per_request` (histogram, labels: tier)
- `browser_pool_size` (gauge, labels: state)
- `queue_depth` (gauge, labels: priority)
- `proxy_success_rate` (gauge, labels: provider, tier)
- `cache_hit_rate` (gauge)
- `memory_usage_bytes` (gauge, labels: process)

### Step 6.2 — Grafana dashboards

1. **Overview** — Requests/s, success rate, P95 latency, cost/hour
2. **Browser Pool** — Context utilization, recycle rate, per-process memory
3. **Proxy Health** — Success rate by provider/tier, cost breakdown
4. **Queue** — Depth per priority, avg processing time, backlog growth

### Step 6.3 — Alert rules

- Success rate < 90% for 5 min → Warning
- Queue depth > 500 for 10 min → Warning
- Memory > 85% for 3 min → Critical
- Browser pool exhausted for 1 min → Critical

### Step 6.4 — Load testing with k6

Create `tests/load/k6-load-test.js` — simulate 100, 500, 1000 concurrent users. Verify P95 latency stays under 5s, error rate stays under 5%.

### Step 6.5 — Security hardening

- Input validation on all endpoints (already done via Zod)
- Request size limits (1MB body, enforced by Fastify)
- Rate limiting per API key (already done)
- SQL injection prevention (parameterized queries, already done)
- SSRF prevention: block private IP ranges, localhost, and internal networks in scrape URLs
- API key rotation support
- CORS configuration for dashboard domain only

### Step 6.6 — API documentation

- OpenAPI 3.1 spec (`docs/openapi.yaml`) covering all endpoints
- Host on Mintlify or Docusaurus with interactive examples
- Include authentication guide, error codes reference, and rate limiting details

### Acceptance criteria for Phase 6

1. Grafana dashboards display real-time metrics
2. Alerts fire correctly when thresholds are breached (test by artificially raising queue depth)
3. k6 load test completes at 500 concurrent users with <5% error rate
4. SSRF protection blocks requests to `http://localhost`, `http://169.254.169.254`, and private IPs
5. API documentation site is live and all endpoints are documented

---

## Phase 7 — Deployment and Launch (Week 7-8)

### Goal
Deploy to production on DigitalOcean/Hetzner, set up CI/CD, prepare launch materials, and onboard beta users.

### Step 7.1 — Production Docker Compose

Create `infra/docker-compose.prod.yml`:
```yaml
version: "3.9"
services:
  api:
    build:
      context: .
      dockerfile: infra/docker/Dockerfile.api
    restart: always
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgres://scrapeforge:${DB_PASSWORD}@postgres:5432/scrapeforge
    ports:
      - "3000:3000"
    mem_limit: 256m
    cpus: 0.5

  worker-http:
    build:
      context: .
      dockerfile: infra/docker/Dockerfile.worker
    restart: always
    environment:
      - NODE_ENV=production
      - WORKER_TYPE=http
      - WORKER_CONCURRENCY=50
    mem_limit: 512m
    cpus: 0.5

  worker-browser:
    build:
      context: .
      dockerfile: infra/docker/Dockerfile.worker
    restart: always
    environment:
      - NODE_ENV=production
      - WORKER_TYPE=browser
      - WORKER_CONCURRENCY=3
      - MAX_BROWSER_CONTEXTS=5
    mem_limit: 2g
    cpus: 2

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    mem_limit: 300m

  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      - POSTGRES_DB=scrapeforge
      - POSTGRES_USER=scrapeforge
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data
    mem_limit: 256m

  nginx:
    image: nginx:alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    mem_limit: 64m

  prometheus:
    image: prom/prometheus
    restart: always
    volumes:
      - ./infra/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    mem_limit: 128m

  grafana:
    image: grafana/grafana-oss
    restart: always
    ports:
      - "3001:3000"
    mem_limit: 128m

volumes:
  redis-data:
  pg-data:
```

### Step 7.2 — Server provisioning

Target: DigitalOcean 4GB RAM, 2 vCPU ($24/mo) for MVP.

`infra/scripts/setup.sh`:
```bash
#!/bin/bash
# System tuning for browser automation
sysctl -w vm.overcommit_memory=1
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_tw_reuse=1
ulimit -n 65535

# Enable swap (2x RAM)
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# Install Docker
curl -fsSL https://get.docker.com | sh

# Firewall (only 80, 443, 22)
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSL with Let's Encrypt
apt install -y certbot
certbot certonly --standalone -d api.scrapeforge.io
```

### Step 7.3 — CI/CD pipeline

GitHub Actions workflow:
1. On push to `main`: run tests, build Docker images, push to registry
2. SSH to production server, pull new images, `docker compose up -d`
3. Health check after deploy, rollback if unhealthy

### Step 7.4 — Launch preparation

1. **Node.js SDK** (`packages/sdk/`) — simple wrapper for all endpoints
2. **3 tutorial blog posts:** Getting started, AI extraction guide, cost optimization tips
3. **Product Hunt listing** prepared with demo video
4. **10-20 beta users** invited from developer communities

### Step 7.5 — Post-launch scaling path

| Traffic      | Infrastructure                        | Cost    |
|:-------------|:--------------------------------------|:--------|
| 50K req/day  | 4GB droplet, single instance          | $24/mo  |
| 150K req/day | 8GB droplet, separate API + worker    | $48/mo  |
| 500K req/day | 2x 8GB + load balancer                | $111/mo |
| 1M+ req/day  | Kubernetes (k3s), multi-node          | $200+/mo|

### Acceptance criteria for Phase 7

1. Production server is running with SSL on `api.scrapeforge.io`
2. All Docker services start and pass health checks
3. A scrape request from the public internet returns correct results
4. Dashboard is accessible and shows real data
5. Stripe billing is live for the Starter plan
6. API documentation is publicly accessible
7. At least 5 beta users have made successful API calls
8. Grafana dashboards are monitoring production metrics

---

## Environment variables reference

```env
# API Server
NODE_ENV=production
PORT=3000
REDIS_URL=redis://redis:6379
DATABASE_URL=postgres://scrapeforge:password@postgres:5432/scrapeforge
LOG_LEVEL=info

# Worker
WORKER_TYPE=browser          # 'http' or 'browser'
WORKER_CONCURRENCY=3
MAX_BROWSER_CONTEXTS=5

# Proxy Providers
IPROYAL_API_KEY=
WEBSHARE_API_KEY=
DATAIMPULSE_API_KEY=

# AI Extraction
GEMINI_API_KEY=
OPENAI_API_KEY=

# CAPTCHA Solving
CAPSOLVER_API_KEY=

# Stripe Billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=price_xxx
STRIPE_PRICE_PRO=price_xxx
STRIPE_PRICE_BUSINESS=price_xxx

# Dashboard
NEXTAUTH_SECRET=
NEXTAUTH_URL=https://app.scrapeforge.io
```

---

## Key design decisions (for AI agents implementing this)

1. **Monorepo with workspaces** — API, Worker, Dashboard, and shared packages live together. Cross-package imports via `@scrapeforge/shared`.

2. **BullMQ is the backbone** — Every request becomes a job. Sync requests (`/v1/scrape` without webhook) use `job.waitUntilFinished()`. Async requests return a `jobId` immediately.

3. **Redis serves triple duty** — Job queue (BullMQ), response cache (with TTL), and domain strategy cache. Single dependency, simple ops.

4. **Workers are stateless except for the browser pool** — Any worker can process any job. The browser pool is the only local state, managed via the pool pattern.

5. **Cost tracking is per-request, not estimated** — Every request logs its actual tier, proxy usage, LLM tokens, and CAPTCHA solves to PostgreSQL. This drives both billing and optimization.

6. **Smart routing is the core value** — The router's decision to use Tier 1 vs Tier 4 for a given domain is what makes the economics work. 80% of sites work with HTTP-only, saving 50-100x compute cost.

7. **Quality scoring is a first-class feature** — Every response includes a 0-1 confidence score. This is a market differentiator and enables automated quality monitoring.

8. **Code generation pattern for AI extraction** — Generate a scraper script once, run it for free forever. Only regenerate when quality drops. This is how you keep AI extraction costs near zero at scale.
