'use server';

import { cookies } from 'next/headers';
import { pool } from '@/lib/db';

export async function loginAction(email: string): Promise<{ error?: string }> {
  const res = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (res.rows.length === 0) {
    return { error: 'User not found. Run the seed script first.' };
  }

  const jar = await cookies();
  jar.set('sf_user_id', res.rows[0].id, {
    httpOnly: true,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    sameSite: 'lax',
  });

  return {};
}
