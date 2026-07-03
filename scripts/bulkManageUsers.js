#!/usr/bin/env node
// Bulk-manage existing accounts: deactivate, reactivate, delete, or change role,
// for many users in one run. Same prerequisites as scripts/createUser.js:
//
//   1. Install Vercel CLI:  npm i -g vercel
//   2. Link your project:   vercel link
//   3. Pull KV env vars:    vercel env pull .env.local
//   4. npm install
//
// Usage:
//   node scripts/bulkManageUsers.js path/to/actions.csv
//
// CSV format (header row required, columns can be in any order):
//   username,action,role
//   daniel,deactivate,
//   ada,activate,
//   chidi,set-role,manager
//   tunde,delete,
//
// Actions:
//   deactivate  — account can no longer log in; kicked out of any active session.
//                 Record is kept (history, transactions, etc. stay intact).
//   activate    — re-enables a previously deactivated account.
//   set-role    — changes the user's role. Requires the "role" column
//                 (realtor, manager, or admin).
//   delete      — permanently removes the account and revokes its sessions.
//                 This cannot be undone — the user will need a brand new
//                 account (and new password) if they come back.
//
// A results file is written next to your input file:
//   actions.csv  ->  actions.results.csv

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@vercel/kv';
import fs from 'fs';
import path from 'path';

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VALID_ROLES = ['realtor', 'manager', 'admin'];
const VALID_ACTIONS = ['deactivate', 'activate', 'set-role', 'delete'];
const SOLE_ADMIN_USERNAME = 'daniel'; // must match api/staff/[action].js

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

function toCsvValue(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function getUsers() {
  return (await kv.get('users')) ?? [];
}
async function saveUsers(users) {
  await kv.set('users', users);
}
async function getSessions() {
  return (await kv.get('sessions')) ?? [];
}
async function saveSessions(sessions) {
  await kv.set('sessions', sessions);
}

async function revokeSessionsForUsername(username) {
  const sessions = await getSessions();
  const filtered = sessions.filter((s) => s.username !== username);
  if (filtered.length !== sessions.length) await saveSessions(filtered);
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('\n❌ KV environment variables not found.');
    console.error('   Run: vercel link && vercel env pull .env.local\n');
    process.exit(1);
  }

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('\nUsage: node scripts/bulkManageUsers.js path/to/actions.csv\n');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`\n❌ File not found: ${inputPath}\n`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    console.error('\n❌ CSV has no data rows.\n');
    process.exit(1);
  }

  const users = await getUsers();
  const results = [];

  for (const row of rows) {
    const username = (row.username || '').trim().toLowerCase();
    const action = (row.action || '').trim().toLowerCase();
    const role = (row.role || '').trim().toLowerCase();

    if (!username) {
      results.push({ username: '', action, role, status: 'SKIPPED — missing username' });
      continue;
    }
    if (!VALID_ACTIONS.includes(action)) {
      results.push({ username, action, role, status: `SKIPPED — invalid action "${action}"` });
      continue;
    }

    const idx = users.findIndex((u) => u.username === username);
    if (idx === -1) {
      results.push({ username, action, role, status: 'SKIPPED — user not found' });
      continue;
    }

    if (action === 'delete') {
      if (username === SOLE_ADMIN_USERNAME) {
        results.push({ username, action, role: users[idx]?.role || '', status: `SKIPPED — "${SOLE_ADMIN_USERNAME}" cannot be removed` });
        continue;
      }
      users.splice(idx, 1);
      await revokeSessionsForUsername(username);
      results.push({ username, action, role: users[idx]?.role || '', status: 'DELETED' });
    } else if (action === 'deactivate') {
      if (username === SOLE_ADMIN_USERNAME) {
        results.push({ username, action, role: users[idx].role, status: `SKIPPED — "${SOLE_ADMIN_USERNAME}" cannot be deactivated` });
        continue;
      }
      users[idx].active = false;
      await revokeSessionsForUsername(username);
      results.push({ username, action, role: users[idx].role, status: 'DEACTIVATED' });
    } else if (action === 'activate') {
      users[idx].active = true;
      results.push({ username, action, role: users[idx].role, status: 'ACTIVATED' });
    } else if (action === 'set-role') {
      if (!VALID_ROLES.includes(role)) {
        results.push({ username, action, role, status: `SKIPPED — invalid role "${role}"` });
        continue;
      }
      if (role === 'admin' && username !== SOLE_ADMIN_USERNAME) {
        results.push({ username, action, role, status: `SKIPPED — only "${SOLE_ADMIN_USERNAME}" can be admin` });
        continue;
      }
      if (username === SOLE_ADMIN_USERNAME && role !== 'admin') {
        results.push({ username, action, role, status: `SKIPPED — "${SOLE_ADMIN_USERNAME}" must stay admin` });
        continue;
      }
      users[idx].role = role;
      results.push({ username, action, role, status: 'ROLE UPDATED' });
    }
  }

  await saveUsers(users);

  const outPath = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + '.results.csv'
  );
  const header = 'username,action,role,status';
  const lines = [header, ...results.map((r) =>
    [r.username, r.action, r.role, r.status].map(toCsvValue).join(',')
  )];
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  console.log('\n=== Bulk user management summary ===');
  for (const r of results) {
    const ok = ['DELETED', 'DEACTIVATED', 'ACTIVATED', 'ROLE UPDATED'].includes(r.status);
    console.log(`${ok ? '✅' : '⚠️'} ${r.username || '(blank)'} — ${r.status}`);
  }
  console.log(`\nResults written to:\n  ${outPath}\n`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
