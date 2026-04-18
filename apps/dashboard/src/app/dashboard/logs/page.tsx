import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Card } from '@/components/card';
import { LogsClient } from './client';

export default async function LogsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="space-y-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
        Request Logs
      </h1>
      <Card className="!p-0">
        <LogsClient userId={session.userId} />
      </Card>
    </div>
  );
}
