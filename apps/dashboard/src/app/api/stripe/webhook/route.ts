import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { pool } from '@/lib/db';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

export async function POST(request: NextRequest) {
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature') || '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;
      if (userId && plan) {
        await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);
        console.log(`[Stripe] User ${userId} upgraded to ${plan}`);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      if (sub.status === 'canceled' || sub.status === 'unpaid') {
        const customerId = sub.customer as string;
        await pool.query(
          `UPDATE users SET plan = 'free' WHERE stripe_customer_id = $1`,
          [customerId],
        );
        console.log(`[Stripe] Customer ${customerId} downgraded to free`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      await pool.query(
        `UPDATE users SET plan = 'free' WHERE stripe_customer_id = $1`,
        [customerId],
      );
      console.log(`[Stripe] Customer ${customerId} subscription deleted`);
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
