'use client';

import { RequestsAreaChart, TierBarChart } from '@/components/charts';

export function OverviewCharts({
  requestsOverTime,
  tierBreakdown,
  tierOnly,
}: {
  requestsOverTime: { date: string; count: number }[];
  tierBreakdown: Record<string, number>;
  tierOnly?: boolean;
}) {
  if (tierOnly) {
    return <TierBarChart data={tierBreakdown} />;
  }
  return <RequestsAreaChart data={requestsOverTime} />;
}
