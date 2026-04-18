import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Card, StatCard } from '@/components/card';
import { UsageClient } from './client';

export default async function UsagePage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="space-y-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
        Usage
      </h1>
      <UsageClient userId={session.userId} />
    </div>
  );
}
