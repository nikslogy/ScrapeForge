'use client';

import { useState, useEffect, useTransition } from 'react';
import { getUsageData, type UsageDay } from '@/lib/actions/usage';
import { Card, StatCard } from '@/components/card';
import { UsageStackedChart } from '@/components/charts';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function UsageClient({ userId }: { userId: string }) {
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');
  const [data, setData] = useState<UsageDay[]>([]);
  const [isPending, start] = useTransition();

  const rangeMap = { '7d': 7, '30d': 30, '90d': 90 };

  useEffect(() => {
    start(async () => {
      const end = new Date().toISOString().slice(0, 10);
      const startDate = daysAgo(rangeMap[range]);
      const result = await getUsageData(userId, startDate, end);
      setData(result);
    });
  }, [range, userId]);

  const totalReqs = data.reduce((s, d) => s + d.totalRequests, 0);
  const totalCost = data.reduce((s, d) => s + d.totalCost, 0);
  const avgLat = data.length > 0
    ? Math.round(data.reduce((s, d) => s + d.avgLatency, 0) / data.length)
    : 0;
  const successPct = totalReqs > 0
    ? Math.round(
        (data.reduce((s, d) => s + d.successfulRequests, 0) / totalReqs) * 100,
      )
    : 0;

  return (
    <div className="space-y-6">
      {/* Range picker */}
      <div className="flex gap-2">
        {(['7d', '30d', '90d'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              range === r
                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                : 'text-charcoal-500 border border-charcoal-700 hover:border-charcoal-600 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Summary stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Requests" value={totalReqs.toLocaleString()} accent />
        <StatCard label="Success Rate" value={`${successPct}%`} />
        <StatCard label="Avg Latency" value={`${avgLat}ms`} />
        <StatCard label="Total Cost" value={`$${totalCost.toFixed(4)}`} accent />
      </div>

      {/* Stacked tier chart */}
      <Card>
        <h2 className="mb-3 text-sm font-medium text-charcoal-500">
          Requests by Tier
        </h2>
        {isPending ? (
          <div className="flex h-[300px] items-center justify-center text-charcoal-600">
            Loading...
          </div>
        ) : data.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-charcoal-600">
            No data for this period.
          </div>
        ) : (
          <UsageStackedChart data={data} />
        )}
      </Card>

      {/* Daily breakdown table */}
      <Card>
        <h2 className="mb-3 text-sm font-medium text-charcoal-500">Daily Breakdown</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-charcoal-800 text-xs uppercase tracking-wider text-charcoal-500">
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Requests</th>
                <th className="pb-2 pr-4 font-medium">Success</th>
                <th className="pb-2 pr-4 font-medium">Failed</th>
                <th className="pb-2 pr-4 font-medium">Cost</th>
                <th className="pb-2 pr-4 font-medium">Avg Latency</th>
                <th className="pb-2 font-medium">Avg Quality</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date} className="border-b border-charcoal-800/50">
                  <td className="py-2 pr-4 font-[family-name:var(--font-mono)] text-xs text-charcoal-500">{d.date}</td>
                  <td className="py-2 pr-4 text-white">{d.totalRequests}</td>
                  <td className="py-2 pr-4 text-emerald-400">{d.successfulRequests}</td>
                  <td className="py-2 pr-4 text-rose-400">{d.failedRequests}</td>
                  <td className="py-2 pr-4 text-amber-400">${d.totalCost.toFixed(4)}</td>
                  <td className="py-2 pr-4 text-charcoal-500">{d.avgLatency}ms</td>
                  <td className="py-2 text-charcoal-500">{d.avgQuality.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
