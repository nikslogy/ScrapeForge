'use server';

import { pool } from '../db';

export interface UsageDay {
  date: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  tier1: number;
  tier2: number;
  tier3: number;
  tier4: number;
  totalCost: number;
  avgLatency: number;
  avgQuality: number;
}

export async function getUsageData(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<UsageDay[]> {
  const res = await pool.query(
    `SELECT
       created_at::date                                              AS date,
       COUNT(*)::int                                                 AS total_requests,
       COUNT(*) FILTER (WHERE status = 'completed')::int             AS successful_requests,
       COUNT(*) FILTER (WHERE status = 'failed')::int                AS failed_requests,
       COUNT(*) FILTER (WHERE tier_used = 1)::int                    AS tier1,
       COUNT(*) FILTER (WHERE tier_used = 2)::int                    AS tier2,
       COUNT(*) FILTER (WHERE tier_used = 3)::int                    AS tier3,
       COUNT(*) FILTER (WHERE tier_used >= 4)::int                   AS tier4,
       COALESCE(SUM(total_cost), 0)::numeric                         AS total_cost,
       COALESCE(AVG(latency_ms)::int, 0)                             AS avg_latency,
       COALESCE(AVG(quality_score)::numeric(3,2), 0)                 AS avg_quality
     FROM request_logs
     WHERE user_id = $1
       AND created_at::date BETWEEN $2 AND $3
     GROUP BY created_at::date
     ORDER BY date`,
    [userId, startDate, endDate],
  );

  return res.rows.map((r: any) => ({
    date: r.date.toISOString().slice(0, 10),
    totalRequests: r.total_requests,
    successfulRequests: r.successful_requests,
    failedRequests: r.failed_requests,
    tier1: r.tier1,
    tier2: r.tier2,
    tier3: r.tier3,
    tier4: r.tier4,
    totalCost: parseFloat(r.total_cost),
    avgLatency: r.avg_latency,
    avgQuality: parseFloat(r.avg_quality),
  }));
}
