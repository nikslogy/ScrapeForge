'use client';

import { useState, useEffect, useTransition } from 'react';
import { getLogs, type LogRow, type LogsResult } from '@/lib/actions/logs';

export function LogsClient({ userId }: { userId: string }) {
  const [data, setData] = useState<LogsResult>({ rows: [], total: 0, page: 1, pageSize: 25 });
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [tierFilter, setTierFilter] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  useEffect(() => {
    start(async () => {
      const result = await getLogs(userId, {
        page,
        status: statusFilter || undefined,
        domain: domainFilter || undefined,
        tier: tierFilter || undefined,
      });
      setData(result);
    });
  }, [page, statusFilter, domainFilter, tierFilter, userId]);

  const totalPages = Math.ceil(data.total / data.pageSize);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 border-b border-charcoal-800 px-5 py-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 text-xs text-white outline-none"
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        <input
          type="text"
          placeholder="Filter by domain..."
          value={domainFilter}
          onChange={(e) => { setDomainFilter(e.target.value); setPage(1); }}
          className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 text-xs text-white placeholder-charcoal-500 outline-none focus:border-amber-500/50"
        />

        <select
          value={tierFilter}
          onChange={(e) => { setTierFilter(Number(e.target.value)); setPage(1); }}
          className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-1.5 text-xs text-white outline-none"
        >
          <option value={0}>All tiers</option>
          <option value={1}>Tier 1</option>
          <option value={2}>Tier 2</option>
          <option value={3}>Tier 3</option>
          <option value={4}>Tier 4+</option>
        </select>

        <span className="ml-auto text-xs text-charcoal-500">
          {data.total} total results
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-charcoal-800 text-xs uppercase tracking-wider text-charcoal-500">
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">URL</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Proxy</th>
              <th className="px-3 py-2 font-medium">Latency</th>
              <th className="px-3 py-2 font-medium">Quality</th>
              <th className="px-3 py-2 font-medium">Cost</th>
              <th className="px-3 py-2 font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <LogRowComponent
                key={row.id}
                row={row}
                isExpanded={expanded === row.id}
                onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
              />
            ))}
            {data.rows.length === 0 && !isPending && (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-charcoal-500">
                  No logs found.
                </td>
              </tr>
            )}
            {isPending && (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-charcoal-600">
                  Loading...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-charcoal-800 px-5 py-3">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="rounded-md border border-charcoal-700 px-3 py-1 text-xs text-charcoal-500 transition-colors hover:text-white disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-xs text-charcoal-500">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="rounded-md border border-charcoal-700 px-3 py-1 text-xs text-charcoal-500 transition-colors hover:text-white disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function LogRowComponent({
  row,
  isExpanded,
  onToggle,
}: {
  row: LogRow;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-charcoal-800/50 transition-colors hover:bg-charcoal-800/30"
      >
        <td className="px-5 py-2.5">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              row.status === 'completed'
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-rose-500/10 text-rose-400'
            }`}
          >
            {row.statusCode ?? row.status}
          </span>
        </td>
        <td className="max-w-[240px] truncate px-3 py-2.5 font-[family-name:var(--font-mono)] text-xs text-charcoal-500">
          {row.url}
        </td>
        <td className="px-3 py-2.5 text-xs text-white">T{row.tierUsed ?? '-'}</td>
        <td className="px-3 py-2.5 text-xs text-charcoal-500">{row.proxyTier ?? '-'}</td>
        <td className="px-3 py-2.5 text-xs text-charcoal-500">{row.latencyMs ?? '-'}ms</td>
        <td className="px-3 py-2.5 text-xs text-charcoal-500">{row.qualityScore ?? '-'}</td>
        <td className="px-3 py-2.5 text-xs text-amber-400">
          ${row.totalCost?.toFixed(6) ?? '-'}
        </td>
        <td className="px-3 py-2.5 text-xs text-charcoal-600">
          {new Date(row.createdAt).toLocaleTimeString()}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-charcoal-800">
          <td colSpan={8} className="bg-charcoal-800/20 px-5 py-3">
            <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Job ID" value={row.jobId} mono />
              <Detail label="Domain" value={row.domain} />
              <Detail label="Full URL" value={row.url} mono />
              <Detail label="Created" value={new Date(row.createdAt).toISOString()} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-charcoal-600">{label}</p>
      <p
        className={`mt-0.5 break-all text-white ${
          mono ? 'font-[family-name:var(--font-mono)]' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}
