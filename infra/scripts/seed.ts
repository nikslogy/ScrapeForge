import { Pool } from 'pg';
import { generateApiKey } from '@scrapeforge/shared';

const pg = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://scrapeforge:localdev123@localhost:5433/scrapeforge',
});

async function seed() {
  const userResult = await pg.query(
    `INSERT INTO users (email, name, plan)
     VALUES ('dev@scrapeforge.io', 'Dev User', 'pro')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const userId = userResult.rows[0].id;

  const { raw, hash, prefix } = generateApiKey();

  await pg.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, rate_limit_per_minute)
     VALUES ($1, $2, $3, 'Dev Key', 120)`,
    [userId, hash, prefix],
  );

  console.log('='.repeat(60));
  console.log('TEST API KEY (save this, it will not be shown again):');
  console.log(raw);
  console.log('='.repeat(60));

  await pg.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
