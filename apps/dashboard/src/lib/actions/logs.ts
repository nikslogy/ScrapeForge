'use server';

import { pool } from '../db';

export interface LogRow {
  id: string;
  jobId: string;
  url: string;
  domain: string;
  status: string;
  statusCode: number | null;
  tierUsed: number | null;
  proxyTier: string | null;
  latencyMs: number | null;
  qualityScore: number | null;
  totalCost: number | null;
  createdAt: string;
}

export interface LogsResult {
  rows: LogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getLogs(
  userId: string,
  opts: {
    page?: number;
    pageSize?: number;
    status?: string;
    domain?: string;
    tier?: number;
  } = {},
): Promise<LogsResult> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 25, 100);
  const offset = (page - 1) * pageSize;

  const conditions = ['user_id = $1'];
  const params: unknown[] = [userId];
  let idx = 2;

  if (opts.status) {
    conditions.push(`status = $${idx++}`);
    params.push(opts.status);
  }
  if (opts.domain) {
    conditions.push(`domain ILIKE $${idx++}`);
    params.push(`%${opts.domain}%`);
  }
  if (opts.tier) {
    conditions.push(`tier_used = $${idx++}`);
    params.push(opts.tier);
  }

  const where = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM request_logs WHERE ${where}`,
    params,
  );

  const dataRes = await pool.query(
    `SELECT id, job_id, url, domain, status, status_code, tier_used, proxy_tier,
            latency_ms, quality_score, total_cost, created_at
     FROM request_logs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, pageSize, offset],
  );

  return {
    rows: dataRes.rows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      url: r.url,
      domain: r.domain,
      status: r.status,
      statusCode: r.status_code,
      tierUsed: r.tier_used,
      proxyTier: r.proxy_tier,
      latencyMs: r.latency_ms,
      qualityScore: r.quality_score ? parseFloat(r.quality_score) : null,
      totalCost: r.total_cost ? parseFloat(r.total_cost) : null,
      createdAt: r.created_at.toISOString(),
    })),
    total: countRes.rows[0].total,
    page,
    pageSize,
  };
}
