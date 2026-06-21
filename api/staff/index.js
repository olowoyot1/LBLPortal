// api/staff/index.js
// GET    /api/staff                     → list all users (admin only)
// POST   /api/staff                     → create user (admin only)
// DELETE /api/staff?username=daniel     → remove user (admin only)

import bcrypt from 'bcryptjs';
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getUsers, saveUsers } from '../_lib/db.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    // Only admins can manage staff
    if (session.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can manage staff accounts.' });
    }

    // GET — list all users (strip password hashes)
    if (req.method === 'GET') {
      const users = await getUsers();
      return res.json(users.map(({ passwordHash, ...u }) => u));
    }

    // POST — create a new user
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

    // DELETE — remove a user
    if (req.method === 'DELETE') {
      const username = (req.query.username || '').trim().toLowerCase();
      if (!username) return res.status(400).json({ error: 'Username is required.' });

      // Prevent admin from deleting themselves
      if (username === session.username) {
        return res.status(400).json({ error: 'You cannot remove your own account.' });
      }

      const users = await getUsers();
      const exists = users.some((u) => u.username === username);
      if (!exists) return res.status(404).json({ error: `User "${username}" not found.` });

      await saveUsers(users.filter((u) => u.username !== username));
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
