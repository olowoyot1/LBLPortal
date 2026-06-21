// api/setup.js
// One-time endpoint to create user accounts from your browser.
// Protected by SETUP_SECRET env var so only you can use it.
//
// Usage:
//   https://your-project.vercel.app/api/setup?secret=YOUR_SECRET&username=daniel&password=MyPass123&name=Daniel%20Okafor&role=admin
//
// DELETE THIS FILE after you have created all your users.

import bcrypt from 'bcryptjs';
import { getUsers, saveUsers } from './_lib/db.js';

export default async function handler(req, res) {
  // Only allow GET for easy browser use
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const setupSecret = process.env.SETUP_SECRET;

  // If no SETUP_SECRET is set, refuse to work
  if (!setupSecret) {
    return res.status(500).json({
      error: 'SETUP_SECRET environment variable is not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  const { secret, username, password, name, role } = req.query;

  // Check secret
  if (secret !== setupSecret) {
    return res.status(401).json({ error: 'Invalid setup secret.' });
  }

  // Validate inputs
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

  try {
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
      reminder: 'Delete api/setup.js from your project once all users are created.'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
