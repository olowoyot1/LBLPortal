// api/staff/[action].js
// Consolidated admin/ops endpoint, kept in one Serverless Function to stay
// under the Vercel Hobby plan's 12-function cap.
//
// Public URLs are unchanged (mapped via vercel.json rewrites):
//   GET    /api/staff                  -> action=manage  (list, admin only)
//   POST   /api/staff                  -> action=manage  (create, admin only)
//   DELETE /api/staff?username=...     -> action=manage  (remove, admin only)
//   GET    /api/setup?secret=...       -> action=setup   (one-time bootstrap)
//   GET    /api/health                 -> action=health  (uptime ping)
//
// NOTE: api/setup (action=setup) is a one-time bootstrap endpoint for
// creating your first user accounts. The original file carried a reminder
// to delete it once accounts exist — that's still good advice. It stays
// gated behind SETUP_SECRET, but if your users are already set up, ask
// to have this branch removed entirely rather than just left dormant.
import bcrypt from 'bcryptjs';
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getUsers, saveUsers } from '../_lib/db.js';

async function manage(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;

  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can manage staff accounts.' });
  }

  if (req.method === 'GET') {
    const users = await getUsers();
    return res.json(users.map(({ passwordHash, ...u }) => u));
  }

  if (req.method === 'POST') {
    const { username, displayName, password, role } = req.body || {};

    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'Username, display name, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanRole = ['realtor', 'manager', 'admin'].includes(role) ? role : 'realtor';

    const users = await getUsers();
    if (users.some((u) => u.username === cleanUsername)) {
      return res.status(409).json({ error: `Username "${cleanUsername}" is already taken.` });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `u_${Date.now()}`,
      username: cleanUsername,
      displayName: displayName.trim(),
      role: cleanRole,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    users.push(user);
    await saveUsers(users);

    const { passwordHash: _, ...safeUser } = user;
    return res.status(201).json(safeUser);
  }

  if (req.method === 'DELETE') {
    const username = (req.query.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username is required.' });

    if (username === session.username) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }

    const users = await getUsers();
    const exists = users.some((u) => u.username === username);
    if (!exists) return res.status(404).json({ error: `User "${username}" not found.` });

    await saveUsers(users.filter((u) => u.username !== username));
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function setup(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const setupSecret = process.env.SETUP_SECRET;

  if (!setupSecret) {
    return res.status(500).json({
      error: 'SETUP_SECRET environment variable is not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  const { secret, username, password, name, role } = req.query;

  if (secret !== setupSecret) {
    return res.status(401).json({ error: 'Invalid setup secret.' });
  }

  if (!username || !password || !name) {
    return res.status(400).json({
      error: 'Missing fields.',
      usage: '/api/setup?secret=YOUR_SECRET&username=daniel&password=MyPass123&name=Daniel%20Okafor&role=admin',
      roles: 'realtor (default), manager, admin'
    });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanRole = ['realtor', 'manager', 'admin'].includes(role) ? role : 'realtor';

  const users = await getUsers();

  if (users.some((u) => u.username === cleanUsername)) {
    return res.status(409).json({ error: `User "${cleanUsername}" already exists.` });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: `u_${Date.now()}`,
    username: cleanUsername,
    displayName: name.trim(),
    role: cleanRole,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await saveUsers(users);

  return res.status(200).json({
    success: true,
    message: `User "${cleanUsername}" created successfully.`,
    user: {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
    reminder: 'Once all your users are created, ask Claude to remove the setup action from api/staff/[action].js.'
  });
}

function health(req, res) {
  res.json({ ok: true });
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { action } = req.query;

  try {
    if (action === 'health') return health(req, res);
    if (action === 'setup') return await setup(req, res);
    if (action === 'manage') return await manage(req, res);
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
