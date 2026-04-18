'use server';

import Stripe from 'stripe';
import { pool } from '../db';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const PLAN_PRICES: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER || 'price_starter',
  pro: process.env.STRIPE_PRICE_PRO || 'price_pro',
  business: process.env.STRIPE_PRICE_BUSINESS || 'price_business',
};

const DASHBOARD_URL = process.env.NEXTAUTH_URL || 'http://localhost:3001';

export async function createCheckoutSession(
  userId: string,
  plan: string,
): Promise<{ url: string | null }> {
  if (!stripe) return { url: null };

  const priceId = PLAN_PRICES[plan];
  if (!priceId) return { url: null };

  const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = userRes.rows[0]?.email;

  let customerId = await getOrCreateStripeCustomer(userId, email);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${DASHBOARD_URL}/dashboard/settings?checkout=success`,
    cancel_url: `${DASHBOARD_URL}/dashboard/settings?checkout=cancelled`,
    metadata: { userId, plan },
  });

  return { url: session.url };
}

export async function createBillingPortalSession(
  userId: string,
): Promise<{ url: string | null }> {
  if (!stripe) return { url: null };

  const custRes = await pool.query(
    `SELECT email FROM users WHERE id = $1`,
    [userId],
  );
  const email = custRes.rows[0]?.email;
  const customerId = await getOrCreateStripeCustomer(userId, email);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${DASHBOARD_URL}/dashboard/settings`,
  });

  return { url: session.url };
}

/**
 * Report metered usage to Stripe. Called hourly by a cron or background job.
 * Aggregates the last hour of requests per user and sends to Stripe's usage records.
 */
export async function reportMeteredUsage(): Promise<void> {
  if (!stripe) return;

  const res = await pool.query(`
    SELECT u.id AS user_id, COUNT(rl.*)::int AS request_count
    FROM users u
    JOIN request_logs rl ON rl.user_id = u.id
    WHERE rl.created_at >= NOW() - INTERVAL '1 hour'
    GROUP BY u.id
  `);

  for (const row of res.rows) {
    try {
      const customerId = await getOrCreateStripeCustomer(row.user_id, null);

      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
      });

      const sub = subscriptions.data[0];
      if (!sub) continue;

      const meteredItem = sub.items.data.find(
        (item) => item.price.recurring?.usage_type === 'metered',
      );
      if (!meteredItem) continue;

      await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
        quantity: row.request_count,
        timestamp: Math.floor(Date.now() / 1000),
        action: 'increment',
      });
    } catch (err) {
      console.error(`[Stripe] Usage report failed for user ${row.user_id}:`, err);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────

async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const existing = await pool.query(
    `SELECT stripe_customer_id FROM users WHERE id = $1 AND stripe_customer_id IS NOT NULL`,
    [userId],
  );

  if (existing.rows[0]?.stripe_customer_id) {
    return existing.rows[0].stripe_customer_id;
  }

  if (!stripe) throw new Error('Stripe not configured');

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { userId },
  });

  await pool.query(
    `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, userId],
  );

  return customer.id;
}
