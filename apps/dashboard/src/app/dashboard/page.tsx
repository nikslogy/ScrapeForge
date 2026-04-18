import { getOverviewStats } from '@/lib/actions/stats';
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { StatCard, Card } from '@/components/card';
import { OverviewCharts } from './overview-charts';

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const stats = await getOverviewStats(session.userId);

  return (
    <div className="space-y-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
        Overview
      </h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Requests Today" value={stats.totalToday.toLocaleString()} accent />
        <StatCard label="Success Rate" value={`${stats.successRate}%`} sub="today" />
        <StatCard label="Avg Latency" value={`${stats.avgLatency}ms`} sub="today" />
        <StatCard
          label="Cost This Month"
          value={`$${stats.costThisMonth.toFixed(4)}`}
          accent
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-charcoal-500">Requests (30 days)</h2>
          <OverviewCharts
            requestsOverTime={stats.requestsOverTime}
            tierBreakdown={stats.tierBreakdown}
          />
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-medium text-charcoal-500">Tier Breakdown</h2>
          <OverviewCharts
            tierOnly
            requestsOverTime={stats.requestsOverTime}
            tierBreakdown={stats.tierBreakdown}
          />
        </Card>
      </div>
    </div>
  );
}
