// api/auth/login.js
import { handleCors } from '../_lib/cors.js';
import { getUsers } from '../_lib/db.js';
import { verifyPassword, createSession } from '../_lib/auth.js';

const isProd = process.env.NODE_ENV === 'production';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = await getUsers();
    const user = users.find((u) => u.username === username.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    const token = await createSession(user);

    res.setHeader(
      'Set-Cookie',
      `session=${token}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${isProd ? '; Secure' : ''}`
    );
    res.json({ displayName: user.displayName, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
