'use server';

import { pool } from '../db';

export interface OverviewStats {
  totalToday: number;
  successRate: number;
  avgLatency: number;
  costThisMonth: number;
  requestsOverTime: { date: string; count: number }[];
  tierBreakdown: Record<string, number>;
}

export async function getOverviewStats(userId: string): Promise<OverviewStats> {
  const todayRes = await pool.query(
    `SELECT
       COUNT(*)::int                                             AS total,
       COUNT(*) FILTER (WHERE status = 'completed')::int         AS success,
       COALESCE(AVG(latency_ms)::int, 0)                         AS avg_latency
     FROM request_logs
     WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
    [userId],
  );

  const row = todayRes.rows[0];
  const successRate = row.total > 0 ? Math.round((row.success / row.total) * 100) : 0;

  const costRes = await pool.query(
    `SELECT COALESCE(SUM(total_cost), 0)::numeric AS cost
     FROM request_logs
     WHERE user_id = $1
       AND created_at >= date_trunc('month', CURRENT_DATE)`,
    [userId],
  );

  const chartRes = await pool.query(
    `SELECT created_at::date AS date, COUNT(*)::int AS count
     FROM request_logs
     WHERE user_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY created_at::date
     ORDER BY date`,
    [userId],
  );

  const tierRes = await pool.query(
    `SELECT tier_used, COUNT(*)::int AS count
     FROM request_logs
     WHERE user_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY tier_used`,
    [userId],
  );

  const tierBreakdown: Record<string, number> = {};
  for (const r of tierRes.rows) {
    tierBreakdown[`Tier ${r.tier_used}`] = r.count;
  }

  return {
    totalToday: row.total,
    successRate,
    avgLatency: row.avg_latency,
    costThisMonth: parseFloat(costRes.rows[0].cost),
    requestsOverTime: chartRes.rows.map((r: any) => ({
      date: r.date.toISOString().slice(0, 10),
      count: r.count,
    })),
    tierBreakdown,
  };
}
