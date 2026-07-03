#!/usr/bin/env node
// Set or renew the app's license/subscription record (LOCAL MODE).
//
// This only matters if you have NOT set LICENSE_SERVER_URL — see
// api/_lib/license.js for the remote-mode explanation.
//
// Prerequisites (same as scripts/createUser.js):
//   npm i -g vercel
//   vercel link
//   vercel env pull .env.local
//   npm install
//
// Usage — grant/renew for 30 days from today:
//   node scripts/setLicense.js --days=30
//
// Or set an exact expiry date:
//   node scripts/setLicense.js --validUntil=2026-08-03
//
// Suspend immediately (e.g. non-payment) without deleting the record:
//   node scripts/setLicense.js --status=suspended
//
// Check current status without changing anything:
//   node scripts/setLicense.js --status-only

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] ?? true;
  }
  return args;
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('\n❌ KV environment variables not found.');
    console.error('   Run: vercel link && vercel env pull .env.local\n');
    process.exit(1);
  }

  const args = parseArgs();
  const current = (await kv.get('license')) ?? null;

  if (args['status-only']) {
    console.log('\nCurrent license record:');
    console.log(current ? JSON.stringify(current, null, 2) : '(none set — app will be locked out)');
    return;
  }

  let validUntil = current?.validUntil;
  if (args.validUntil) {
    validUntil = args.validUntil;
  } else if (args.days) {
    const d = new Date();
    d.setDate(d.getDate() + Number(args.days));
    validUntil = d.toISOString().slice(0, 10);
  } else if (!validUntil) {
    // Default: 30 days from today if nothing was set before.
    const d = new Date();
    d.setDate(d.getDate() + 30);
    validUntil = d.toISOString().slice(0, 10);
  }

  const status = args.status || current?.status || 'active';
  const plan = args.plan || current?.plan || 'standard';

  const license = { status, validUntil, plan, updatedAt: new Date().toISOString() };
  await kv.set('license', license);
  // Force the next request to re-check instead of using a stale cache.
  await kv.del('license_cache');

  console.log('\n✅ License updated:');
  console.log(JSON.stringify(license, null, 2));
  console.log('\nTakes effect on the next request (cache cleared).\n');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
