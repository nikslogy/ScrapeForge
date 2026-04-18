'use server';

import { pool } from '../db';
import { generateApiKey } from '@scrapeforge/shared';

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  rateLimitPerMinute: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  const res = await pool.query(
    `SELECT id, name, key_prefix, is_active, rate_limit_per_minute,
            created_at, last_used_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );

  return res.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    isActive: r.is_active,
    rateLimitPerMinute: r.rate_limit_per_minute,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
  }));
}

export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ key: string; id: string }> {
  const { raw, hash, prefix } = generateApiKey();

  const res = await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, hash, prefix, name || 'Untitled Key'],
  );

  return { key: raw, id: res.rows[0].id };
}

export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
}

export async function renameApiKey(userId: string, keyId: string, name: string): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET name = $1 WHERE id = $2 AND user_id = $3`,
    [name, keyId, userId],
  );
}
