'use client';

import { useState, useTransition } from 'react';
import { createCheckoutSession, createBillingPortalSession } from '@/lib/actions/stripe';

export function SettingsClient({
  userId,
  currentPlan,
}: {
  userId: string;
  currentPlan: string;
}) {
  const [isPending, start] = useTransition();

  function handleUpgrade(plan: string) {
    start(async () => {
      const { url } = await createCheckoutSession(userId, plan);
      if (url) window.location.href = url;
    });
  }

  function handlePortal() {
    start(async () => {
      const { url } = await createBillingPortalSession(userId);
      if (url) window.location.href = url;
    });
  }

  return (
    <div className="flex gap-3">
      {currentPlan === 'free' && (
        <button
          onClick={() => handleUpgrade('starter')}
          disabled={isPending}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-charcoal-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
        >
          Upgrade to Starter
        </button>
      )}
      {currentPlan !== 'free' && (
        <button
          onClick={handlePortal}
          disabled={isPending}
          className="rounded-md border border-charcoal-700 px-4 py-2 text-sm font-medium text-charcoal-500 transition-colors hover:text-white disabled:opacity-50"
        >
          Manage Billing
        </button>
      )}
    </div>
  );
}
