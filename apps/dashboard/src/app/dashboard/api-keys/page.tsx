import { getSession } from '@/lib/auth';
import { listApiKeys } from '@/lib/actions/keys';
import { redirect } from 'next/navigation';
import { Card } from '@/components/card';
import { ApiKeysClient } from './client';

export default async function ApiKeysPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const keys = await listApiKeys(session.userId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
          API Keys
        </h1>
      </div>

      <Card>
        <ApiKeysClient initialKeys={keys} userId={session.userId} />
      </Card>
    </div>
  );
}
