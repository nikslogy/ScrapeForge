import { getSession } from '@/lib/auth';
import { listApiKeys } from '@/lib/actions/keys';
import { redirect } from 'next/navigation';
import { Card } from '@/components/card';
import { PlaygroundClient } from './client';

export default async function PlaygroundPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const keys = await listApiKeys(session.userId);
  const activeKeys = keys.filter((k) => k.isActive);

  return (
    <div className="space-y-6">
      <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-white">
        Playground
      </h1>
      <p className="text-sm text-charcoal-500">
        Test the ScrapeForge API interactively. Enter a URL and options, then hit Send.
      </p>
      <PlaygroundClient
        apiKeyPrefixes={activeKeys.map((k) => ({
          id: k.id,
          prefix: k.keyPrefix,
          name: k.name,
        }))}
      />
    </div>
  );
}
