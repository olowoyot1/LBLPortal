// api/staff/[action].js
// Consolidated admin/ops endpoint, kept in one Serverless Function to stay
// under the Vercel Hobby plan's 12-function cap.
//
// Public URLs are unchanged (mapped via vercel.json rewrites):
//   GET    /api/staff                  -> action=manage  (list, admin only)
//   POST   /api/staff                  -> action=manage  (create, admin or manager)
//   PUT    /api/staff?username=...     -> action=manage  (edit, admin only)
//   DELETE /api/staff?username=...     -> action=manage  (remove, admin only)
//   GET    /api/setup?secret=...       -> action=setup   (one-time bootstrap)
//   GET    /api/health                 -> action=health  (uptime ping)
//   GET    /api/license                -> action=license (status, admin only)
//   POST   /api/license                -> action=license (renew, admin only)
//   POST   /api/staff/bulk             -> action=bulk (bulk create, admin or manager)
//
// NOTE: api/setup (action=setup) is a one-time bootstrap endpoint for
// creating your first user accounts. The original file carried a reminder
// to delete it once accounts exist — that's still good advice. It stays
// gated behind SETUP_SECRET, but if your users are already set up, ask
// to have this branch removed entirely rather than just left dormant.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getUsers, saveUsers } from '../_lib/db.js';
import { getLicenseStatus, renewLicense } from '../_lib/license.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(e) {
  return typeof e === 'string' && EMAIL_RE.test(e.trim());
}

// Only this username may ever hold the admin role. Change this if the
// designated admin's username changes.
const SOLE_ADMIN_USERNAME = 'daniel';

// Throws if the requested role/username combination isn't allowed.
// Also refuses to let the sole admin be demoted away from admin, so the
// app can never end up with zero working admin accounts.
function assertRoleAllowed(username, role) {
  const uname = username.trim().toLowerCase();
  if (role === 'admin' && uname !== SOLE_ADMIN_USERNAME) {
    throw new Error(`Only the "${SOLE_ADMIN_USERNAME}" account can hold the admin role.`);
  }
  if (uname === SOLE_ADMIN_USERNAME && role !== 'admin') {
    throw new Error(`The "${SOLE_ADMIN_USERNAME}" account must stay admin.`);
  }
}

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map((n) => chars[n % chars.length]).join('');
}

async function license(req, res) {
  const setupSecret = process.env.SETUP_SECRET;
  const secretMatches = setupSecret && req.query.secret === setupSecret;

  // Two ways in:
  //   1. Logged-in admin (normal day-to-day renewal via the Subscription tab).
  //   2. The same SETUP_SECRET used for /api/setup, passed as ?secret=... in
  //      the URL — this exists purely so the very first activation (before
  //      any admin account can even log in, since login itself is blocked
  //      without a license) can be done from a browser address bar with no
  //      terminal at all.
  if (!secretMatches) {
    const session = await requireAuth(req, res, { allowExpiredForAdmin: true });
    if (!session) return;
    if (session.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can manage the subscription.' });
    }
  }

  if (req.method === 'GET') {
    // Secret + days/validUntil in the query string = renew via plain URL.
    // Secret alone (or a logged-in admin with no body) = just show status.
    const { days, validUntil, status, plan } = req.query;
    if (secretMatches && (days || validUntil || status || plan)) {
      try {
        const result = await renewLicense({ days, validUntil, status, plan });
        return res.json(result);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    return res.json(await getLicenseStatus());
  }

  if (req.method === 'POST') {
    const { days, validUntil, status, plan } = req.body || {};
    try {
      const result = await renewLicense({ days, validUntil, status, plan });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function bulk(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'admin' && session.role !== 'manager') {
    return res.status(403).json({ error: 'Only admins and managers can bulk-create staff accounts.' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows provided.' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'Too many rows in one batch (limit 500).' });
  }

  const users = await getUsers();
  const existing = new Set(users.map((u) => u.username));
  const results = [];

  for (const row of rows) {
    const username = String(row.username || '').trim().toLowerCase();
    const displayName = String(row.name || row.displayName || '').trim() || username;
    const role = String(row.role || 'realtor').trim().toLowerCase() || 'realtor';
    let email = String(row.email || '').trim().toLowerCase();
    let password = String(row.password || '').trim();
    let generated = false;

    if (!username) {
      results.push({ username: '', name: displayName, role, status: 'SKIPPED — missing username' });
      continue;
    }
    if (existing.has(username)) {
      results.push({ username, name: displayName, role, status: 'SKIPPED — already exists' });
      continue;
    }
    if (!['realtor', 'manager', 'admin'].includes(role)) {
      results.push({ username, name: displayName, role, status: `SKIPPED — invalid role "${role}"` });
      continue;
    }
    try {
      assertRoleAllowed(username, role);
    } catch (err) {
      results.push({ username, name: displayName, role, status: `SKIPPED — ${err.message}` });
      continue;
    }
    if (!email) {
      email = `${username}@landblaze.local`; // placeholder; can be edited later in Staff
    } else if (!isValidEmail(email)) {
      results.push({ username, name: displayName, role, status: 'SKIPPED — invalid email' });
      continue;
    }
    if (!password) {
      password = generatePassword();
      generated = true;
    }
    if (password.length < 8) {
      results.push({ username, name: displayName, role, status: 'SKIPPED — password must be at least 8 characters' });
      continue;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      username,
      displayName,
      email,
      role,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    existing.add(username);

    results.push({
      username,
      name: displayName,
      role,
      password: generated ? password : undefined, // only surfaced when auto-generated
      status: generated ? 'CREATED — password auto-generated' : 'CREATED',
    });
  }

  await saveUsers(users);
  return res.json({ results });
}

async function manage(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;

  // Managers may create new staff accounts, but viewing the full roster,
  // editing existing accounts, or removing accounts stays admin-only.
  const canCreate = session.role === 'admin' || session.role === 'manager';
  if (req.method === 'POST') {
    if (!canCreate) {
      return res.status(403).json({ error: 'Only admins and managers can add staff accounts.' });
    }
  } else if (session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can manage staff accounts.' });
  }

  if (req.method === 'GET') {
    const users = await getUsers();
    return res.json(users.map(({ passwordHash, ...u }) => u));
  }

  if (req.method === 'POST') {
    const { username, displayName, password, role, email } = req.body || {};

    if (!username || !displayName || !password || !email) {
      return res.status(400).json({ error: 'Username, display name, email, and password are required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();
    const cleanRole = ['realtor', 'manager', 'admin'].includes(role) ? role : 'realtor';

    try {
      assertRoleAllowed(cleanUsername, cleanRole);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const users = await getUsers();
    if (users.some((u) => u.username === cleanUsername)) {
      return res.status(409).json({ error: `Username "${cleanUsername}" is already taken.` });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `u_${Date.now()}`,
      username: cleanUsername,
      displayName: displayName.trim(),
      email: cleanEmail,
      role: cleanRole,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    users.push(user);
    await saveUsers(users);

    const { passwordHash: _, ...safeUser } = user;
    return res.status(201).json(safeUser);
  }

  if (req.method === 'PUT') {
    const username = (req.query.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username is required.' });

    const users = await getUsers();
    const idx = users.findIndex((u) => u.username === username);
    if (idx === -1) return res.status(404).json({ error: `User "${username}" not found.` });

    const { displayName, email, role, password } = req.body || {};
    const existing = users[idx];
    const updated = { ...existing };

    if (displayName !== undefined) {
      if (!displayName.trim()) return res.status(400).json({ error: 'Display name cannot be empty.' });
      updated.displayName = displayName.trim();
    }

    if (email !== undefined) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      updated.email = email.trim().toLowerCase();
    }

    if (role !== undefined) {
      if (!['realtor', 'manager', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Role must be realtor, manager, or admin.' });
      }
      try {
        assertRoleAllowed(username, role);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      updated.role = role;
    }

    if (password !== undefined && password !== '') {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      updated.passwordHash = await bcrypt.hash(password, 12);
    }

    users[idx] = updated;
    await saveUsers(users);

    const { passwordHash: _, ...safeUser } = updated;
    return res.json(safeUser);
  }

  if (req.method === 'DELETE') {
    const username = (req.query.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username is required.' });

    if (username === session.username) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }
    if (username === SOLE_ADMIN_USERNAME) {
      return res.status(400).json({ error: `The "${SOLE_ADMIN_USERNAME}" account cannot be removed.` });
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

  const { secret, username, password, name, role, email } = req.query;

  if (secret !== setupSecret) {
    return res.status(401).json({ error: 'Invalid setup secret.' });
  }

  if (!username || !password || !name || !email) {
    return res.status(400).json({
      error: 'Missing fields.',
      usage: '/api/setup?secret=YOUR_SECRET&username=daniel&password=MyPass123&name=Daniel%20Okafor&email=daniel%40landblaze.com&role=admin',
      roles: 'realtor (default), manager, admin'
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
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
    email: cleanEmail,
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
      email: user.email,
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
    if (action === 'bulk') return await bulk(req, res);
    if (action === 'license') return await license(req, res);
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
