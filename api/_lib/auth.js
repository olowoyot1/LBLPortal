// api/_lib/auth.js
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getSessions, saveSessions } from './db.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  const sessions = await getSessions();
  sessions.push(session);
  await saveSessions(sessions);
  return token;
}

export async function revokeSession(token) {
  const sessions = await getSessions();
  await saveSessions(sessions.filter((s) => s.token !== token));
}

export async function lookupSession(token) {
  if (!token) return null;
  const now = Date.now();
  let sessions = await getSessions();
  const before = sessions.length;
  sessions = sessions.filter((s) => s.expiresAt > now);
  if (sessions.length !== before) await saveSessions(sessions);
  return sessions.find((s) => s.token === token) ?? null;
}

// Parse the session cookie from the Cookie header string
export function parseSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Middleware-style: returns the session or sends 401
export async function requireAuth(req, res) {
  const token = parseSessionCookie(req.headers.cookie);
  const session = await lookupSession(token);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated. Please log in again.' });
    return null;
  }
  return session;
}
