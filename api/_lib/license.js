// api/_lib/license.js
//
// Subscription/license gate for the app. Two modes:
//
//   LOCAL MODE (default) — the license record lives in this project's own
//   Vercel KV under the key "license". Good enough if this app only ever
//   runs in your own Vercel account: whoever controls the KV controls the
//   license. Use scripts/setLicense.js to create/renew it.
//
//   REMOTE MODE (optional, recommended if you deploy copies of this app to
//   other companies) — set the LICENSE_SERVER_URL and LICENSE_KEY env vars.
//   On each check, the app calls out to a server *you* host separately
//   (not shipped to the client) which returns whether that license key is
//   still valid. Since the client never has access to that server or its
//   database, they can't extend their own subscription by editing code or
//   their own KV. Ask if you want this remote server built — it's a small
//   separate project (a couple of endpoints + its own tiny KV/database).
//
// Either way, the result is cached in KV for CACHE_TTL_MS so we don't
// re-check on literally every request, but short enough that an expired
// subscription takes effect quickly.

import { kv } from '@vercel/kv';

const CACHE_TTL_MS = 60 * 60 * 1000; // re-verify at most once per hour

async function getCache() {
  return (await kv.get('license_cache')) ?? null;
}
async function setCache(result) {
  await kv.set('license_cache', { ...result, checkedAt: Date.now() });
}

async function checkLocal() {
  const license = (await kv.get('license')) ?? null;
  if (!license) {
    return { valid: false, reason: 'No license configured. Run scripts/setLicense.js.' };
  }
  if (license.status !== 'active') {
    return { valid: false, reason: `License status is "${license.status}".` };
  }
  const now = Date.now();
  const validUntil = new Date(license.validUntil).getTime();
  if (!validUntil || isNaN(validUntil)) {
    return { valid: false, reason: 'License has no valid expiry date.' };
  }
  if (now > validUntil) {
    return { valid: false, reason: `License expired on ${license.validUntil}.` };
  }
  return { valid: true, validUntil: license.validUntil, plan: license.plan || 'standard' };
}

async function checkRemote() {
  const url = process.env.LICENSE_SERVER_URL;
  const key = process.env.LICENSE_KEY;
  if (!key) return { valid: false, reason: 'LICENSE_KEY is not set.' };

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // If the license server itself is unreachable/erroring, fail closed
      // (treat as invalid) rather than silently granting access.
      return { valid: false, reason: `License server returned ${res.status}.` };
    }
    const data = await res.json();
    if (!data.valid) {
      return { valid: false, reason: data.reason || 'License server marked this key invalid.' };
    }
    return { valid: true, validUntil: data.validUntil, plan: data.plan || 'standard' };
  } catch (err) {
    return { valid: false, reason: `Could not reach license server: ${err.message}` };
  }
}

export async function checkLicense({ force = false } = {}) {
  if (!force) {
    const cached = await getCache();
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached;
    }
  }

  const result = process.env.LICENSE_SERVER_URL ? await checkRemote() : await checkLocal();
  await setCache(result);
  return result;
}

// Convenience for API handlers: sends a 402 response and returns false if
// the license is invalid/expired, otherwise returns true.
export async function requireLicense(res) {
  const result = await checkLicense();
  if (!result.valid) {
    res.status(402).json({
      error: `Subscription inactive: ${result.reason || 'unknown reason'}. Please renew to continue using this app.`,
      licenseInvalid: true,
    });
    return false;
  }
  return true;
}

// Read the raw license record plus a fresh validity check — used by the
// admin-facing /api/license endpoint.
export async function getLicenseStatus() {
  const record = (await kv.get('license')) ?? null;
  const validity = await checkLicense({ force: true });
  return { record, ...validity };
}

// Create/renew the license record. Only reachable via /api/license (admin
// only, bypasses the expired-license block) or scripts/setLicense.js.
export async function renewLicense({ days, validUntil, status, plan } = {}) {
  const current = (await kv.get('license')) ?? null;

  let newValidUntil = current?.validUntil;
  if (validUntil) {
    newValidUntil = validUntil;
  } else if (days) {
    const n = Number(days);
    if (!n || n <= 0) throw new Error('"days" must be a positive number.');
    const d = new Date();
    d.setDate(d.getDate() + n);
    newValidUntil = d.toISOString().slice(0, 10);
  } else if (!newValidUntil) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    newValidUntil = d.toISOString().slice(0, 10);
  }

  const newStatus = status || current?.status || 'active';
  const newPlan = plan || current?.plan || 'standard';

  const license = { status: newStatus, validUntil: newValidUntil, plan: newPlan, updatedAt: new Date().toISOString() };
  await kv.set('license', license);
  await kv.del('license_cache');

  return { license, ...(await checkLicense({ force: true })) };
}
