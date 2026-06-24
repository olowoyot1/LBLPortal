// api/_lib/db.js
// Replaces lowdb. All data lives in Vercel KV (Redis).
// Keys:
//   users           → JSON array of user objects
//   sessions        → JSON array of session objects
//   transactions    → JSON array of transaction log entries
//   zoho_token      → JSON { accessToken, expiresAt }

import { kv } from '@vercel/kv';

export async function getUsers() {
  return (await kv.get('users')) ?? [];
}

export async function saveUsers(users) {
  await kv.set('users', users);
}

export async function getSessions() {
  return (await kv.get('sessions')) ?? [];
}

export async function saveSessions(sessions) {
  await kv.set('sessions', sessions);
}

export async function getTransactions() {
  return (await kv.get('transactions')) ?? [];
}

export async function saveTransactions(transactions) {
  await kv.set('transactions', transactions);
}

export async function getZohoToken() {
  return (await kv.get('zoho_token')) ?? { accessToken: null, expiresAt: null };
}

export async function saveZohoToken(token) {
  await kv.set('zoho_token', token);
}
