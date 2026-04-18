'use client';

import { useState, useTransition } from 'react';
import type { ApiKeyRow } from '@/lib/actions/keys';
import { createApiKey, revokeApiKey } from '@/lib/actions/keys';

export function ApiKeysClient({
  initialKeys,
  userId,
}: {
  initialKeys: ApiKeyRow[];
  userId: string;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isPending, start] = useTransition();
  const [copied, setCopied] = useState(false);

  function handleCreate() {
    start(async () => {
      const result = await createApiKey(userId, name || 'Untitled Key');
      setNewKeyValue(result.key);
      setName('');
      const updatedKey: ApiKeyRow = {
        id: result.id,
        name: name || 'Untitled Key',
        keyPrefix: result.key.slice(0, 12),
        isActive: true,
        rateLimitPerMinute: 60,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      setKeys((prev) => [updatedKey, ...prev]);
    });
  }

  function handleRevoke(keyId: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    start(async () => {
      await revokeApiKey(userId, keyId);
      setKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, isActive: false } : k)),
      );
    });
  }

  function handleCopy() {
    if (newKeyValue) {
      navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-5">
      {/* Create form */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Key name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-white placeholder-charcoal-500 outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30"
        />
        <button
          onClick={handleCreate}
          disabled={isPending}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-charcoal-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
        >
          {isPending ? 'Creating...' : 'Create Key'}
        </button>
      </div>

      {/* New key banner */}
      {newKeyValue && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="mb-2 text-sm font-medium text-amber-400">
            New API key created — copy it now, it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-charcoal-800 px-3 py-2 font-[family-name:var(--font-mono)] text-sm text-white">
              {newKeyValue}
            </code>
            <button
              onClick={handleCopy}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-xs font-medium text-charcoal-500 transition-colors hover:text-white"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={() => setNewKeyValue(null)}
              className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-xs font-medium text-charcoal-500 transition-colors hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Keys table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-charcoal-800 text-xs uppercase tracking-wider text-charcoal-500">
              <th className="pb-2 pr-4 font-medium">Name</th>
              <th className="pb-2 pr-4 font-medium">Key</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Rate Limit</th>
              <th className="pb-2 pr-4 font-medium">Last Used</th>
              <th className="pb-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-charcoal-800/50">
                <td className="py-3 pr-4 text-white">{key.name}</td>
                <td className="py-3 pr-4">
                  <code className="font-[family-name:var(--font-mono)] text-xs text-charcoal-500">
                    {key.keyPrefix}...
                  </code>
                </td>
                <td className="py-3 pr-4">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      key.isActive
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-rose-500/10 text-rose-400'
                    }`}
                  >
                    {key.isActive ? 'Active' : 'Revoked'}
                  </span>
                </td>
                <td className="py-3 pr-4 text-charcoal-500">
                  {key.rateLimitPerMinute}/min
                </td>
                <td className="py-3 pr-4 text-charcoal-500 text-xs">
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toLocaleDateString()
                    : 'Never'}
                </td>
                <td className="py-3">
                  {key.isActive && (
                    <button
                      onClick={() => handleRevoke(key.id)}
                      disabled={isPending}
                      className="text-xs font-medium text-rose-400 hover:text-rose-300 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-charcoal-500">
                  No API keys yet. Create one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
