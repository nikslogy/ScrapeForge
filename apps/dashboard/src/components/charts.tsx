'use client';

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from 'recharts';

const AXIS_STYLE = { fontSize: 11, fill: '#666' };
const GRID_STROKE = '#333';

export function RequestsAreaChart({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <defs>
          <linearGradient id="amberGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis
          dataKey="date"
          tick={AXIS_STYLE}
          tickFormatter={(d) => d.slice(5)}
        />
        <YAxis tick={AXIS_STYLE} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: '#999' }}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="#f59e0b"
          strokeWidth={2}
          fill="url(#amberGrad)"
          name="Requests"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TierBarChart({
  data,
}: {
  data: Record<string, number>;
}) {
  const chartData = Object.entries(data).map(([name, value]) => ({ name, value }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="name" tick={AXIS_STYLE} />
        <YAxis tick={AXIS_STYLE} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Requests" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function UsageStackedChart({
  data,
}: {
  data: {
    date: string;
    tier1: number;
    tier2: number;
    tier3: number;
    tier4: number;
  }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis
          dataKey="date"
          tick={AXIS_STYLE}
          tickFormatter={(d) => d.slice(5)}
        />
        <YAxis tick={AXIS_STYLE} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: '#999' }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="tier1" stackId="a" fill="#34d399" name="Tier 1 (HTTP)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="tier2" stackId="a" fill="#38bdf8" name="Tier 2 (TLS)" />
        <Bar dataKey="tier3" stackId="a" fill="#a78bfa" name="Tier 3 (Light)" />
        <Bar dataKey="tier4" stackId="a" fill="#f59e0b" name="Tier 4+ (Browser)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
