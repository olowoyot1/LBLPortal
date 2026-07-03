// api/auth/[action].js
// Consolidated auth endpoint: handles /api/auth/login, /api/auth/logout, /api/auth/me
// in a single Serverless Function (Vercel Hobby plan caps total functions at 12).
import { handleCors } from '../_lib/cors.js';
import { getUsers } from '../_lib/db.js';
import { checkLicense } from '../_lib/license.js';
import {
  verifyPassword,
  createSession,
  parseSessionCookie,
  revokeSession,
  requireAuth,
} from '../_lib/auth.js';

const isProd = process.env.NODE_ENV === 'production';

async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = await getUsers();
    const user = users.find((u) => u.username === username.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    if (user.active === false) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact an admin.' });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    // Admins can always sign in, even with an expired/missing subscription,
    // so someone is able to renew it from inside the app. Everyone else is
    // blocked while the subscription is inactive.
    const license = await checkLicense();
    if (!license.valid && user.role !== 'admin') {
      return res.status(402).json({
        error: `Subscription inactive: ${license.reason || 'unknown reason'}. Please renew to continue using this app.`,
        licenseInvalid: true,
      });
    }

    const token = await createSession(user);

    res.setHeader(
      'Set-Cookie',
      `session=${token}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${isProd ? '; Secure' : ''}`
    );
    res.json({
      displayName: user.displayName,
      role: user.role,
      username: user.username,
      email: user.email || '',
      licenseValid: license.valid,
      licenseReason: license.valid ? undefined : license.reason,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

async function logout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const token = parseSessionCookie(req.headers.cookie);
    if (token) await revokeSession(token);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

async function me(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const session = await requireAuth(req, res, { allowExpiredForAdmin: true });
    if (!session) return;
    res.json({
      displayName: session.displayName,
      role: session.role,
      username: session.username,
      email: session.email || '',
      licenseValid: session.licenseValid,
      licenseReason: session.licenseReason,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const { action } = req.query;

  switch (action) {
    case 'login':
      return login(req, res);
    case 'logout':
      return logout(req, res);
    case 'me':
      return me(req, res);
    default:
      return res.status(404).json({ error: 'Not found' });
  }
}
