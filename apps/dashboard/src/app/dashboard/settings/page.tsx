import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Card } from '@/components/card';
import { pool } from '@/lib/db';
import { SettingsClient } from './client';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const userRes = await pool.query(
    `SELECT id, email, name, plan, created_at,
            (SELECT COUNT(*)::int FROM api_keys WHERE user_id = $1 AND is_active = true) AS active_keys,
            (SELECT COUNT(*)::int FROM request_logs WHERE user_id = $1) AS total_requests
     FROM users WHERE id = $1`,
    [session.userId],
  );

  const user = userRes.rows[0];

  return (
    <div className="space-y-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
        Settings
      </h1>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Account info */}
        <Card>
          <h2 className="mb-4 text-sm font-medium text-charcoal-500">Account</h2>
          <dl className="space-y-3 text-sm">
            <Row label="Email" value={user.email} />
            <Row label="User ID" value={user.id} mono />
            <Row label="Member since" value={new Date(user.created_at).toLocaleDateString()} />
            <Row label="Active API keys" value={String(user.active_keys)} />
            <Row label="Total requests" value={user.total_requests.toLocaleString()} />
          </dl>
        </Card>

        {/* Plan */}
        <Card>
          <h2 className="mb-4 text-sm font-medium text-charcoal-500">Plan & Billing</h2>
          <div className="mb-4 flex items-baseline gap-2">
            <span className="rounded-full bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-400 capitalize">
              {user.plan}
            </span>
          </div>
          <PlanTable currentPlan={user.plan} />
          <SettingsClient userId={session.userId} currentPlan={user.plan} />
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between border-b border-charcoal-800/50 pb-2">
      <dt className="text-charcoal-500">{label}</dt>
      <dd className={`text-white ${mono ? 'font-[family-name:var(--font-mono)] text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function PlanTable({ currentPlan }: { currentPlan: string }) {
  const plans = [
    { name: 'Free', price: '$0', requests: '100/day', features: 'Tier 1-2, No proxy' },
    { name: 'Starter', price: '$29', requests: '10K/mo', features: 'All tiers, DC proxy' },
    { name: 'Pro', price: '$99', requests: '100K/mo', features: 'All tiers, All proxies' },
    { name: 'Business', price: '$249', requests: 'Unlimited', features: 'Priority, Dedicated' },
  ];

  return (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-charcoal-800 text-charcoal-500">
            <th className="py-1.5 text-left font-medium">Plan</th>
            <th className="py-1.5 text-left font-medium">Price</th>
            <th className="py-1.5 text-left font-medium">Requests</th>
            <th className="py-1.5 text-left font-medium">Features</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr
              key={p.name}
              className={`border-b border-charcoal-800/30 ${
                p.name.toLowerCase() === currentPlan ? 'bg-amber-500/5' : ''
              }`}
            >
              <td className="py-1.5 text-white">{p.name}</td>
              <td className="py-1.5 text-amber-400">{p.price}</td>
              <td className="py-1.5 text-charcoal-500">{p.requests}</td>
              <td className="py-1.5 text-charcoal-500">{p.features}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
