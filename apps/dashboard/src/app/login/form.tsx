'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { loginAction } from './action';

export function LoginForm() {
  const [email, setEmail] = useState('dev@scrapeforge.io');
  const [error, setError] = useState('');
  const [isPending, start] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const result = await loginAction(email);
      if (result.error) {
        setError(result.error);
      } else {
        router.push('/dashboard');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-xs text-charcoal-500">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30"
        />
      </div>

      {error && (
        <p className="text-sm text-rose-400">{error}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-amber-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
      >
        {isPending ? 'Signing in...' : 'Sign In'}
      </button>

      <p className="text-center text-xs text-charcoal-600">
        Dev mode: enter your seeded user email
      </p>
    </form>
  );
}
