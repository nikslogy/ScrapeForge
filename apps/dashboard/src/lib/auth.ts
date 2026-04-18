import { cookies } from 'next/headers';
import { pool } from './db';

/**
 * Lightweight session: for local dev we read a userId cookie.
 * In production this would be replaced with NextAuth / JWT.
 */
export async function getSession(): Promise<{ userId: string; email: string; plan: string } | null> {
  const jar = await cookies();
  const userId = jar.get('sf_user_id')?.value;
  if (!userId) return null;

  const res = await pool.query(
    'SELECT id, email, plan FROM users WHERE id = $1',
    [userId],
  );
  if (res.rows.length === 0) return null;

  return {
    userId: res.rows[0].id,
    email: res.rows[0].email,
    plan: res.rows[0].plan,
  };
}

export async function requireSession() {
  const session = await getSession();
  if (!session) throw new Error('Unauthorized');
  return session;
}
