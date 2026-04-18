import { Pool } from 'pg';

const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgres://scrapeforge:localdev123@localhost:5433/scrapeforge',
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgPool = pool;
}
