#!/usr/bin/env node
// Bulk-create realtor (or manager/admin) accounts from a CSV file.
// Run this locally, same prerequisites as scripts/createUser.js:
//
//   1. Install Vercel CLI:  npm i -g vercel
//   2. Link your project:   vercel link
//   3. Pull KV env vars:    vercel env pull .env.local
//   4. npm install
//
// Usage:
//   node scripts/bulkCreateUsers.js path/to/realtors.csv
//
// CSV format (header row required, columns can be in any order):
//   username,name,password,role
//   daniel,Daniel Okafor,MyPass123,realtor
//   ada,Ada Nwosu,,realtor          <- blank password = auto-generated
//   chidi,Chidi Eze,Secret456,manager
//
// - "role" is optional, defaults to "realtor". Allowed: realtor, manager, admin.
// - "password" is optional. If left blank, a random 10-character password is
//   generated and printed to the console (and written to an output CSV) so
//   you can hand it to the realtor.
// - Existing usernames are skipped (not overwritten) and reported at the end.
//
// A results file is written next to your input file:
//   realtors.csv  ->  realtors.results.csv
// containing username, name, role, password (plaintext, one-time), and status.
// Treat that results file as sensitive — delete it once passwords are shared.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@vercel/kv';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VALID_ROLES = ['realtor', 'manager', 'admin'];

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomFillSync(new Uint32Array(length)))
    .map((n) => chars[n % chars.length])
    .join('');
}

// Minimal CSV parser: handles quoted fields with commas, no embedded newlines in fields.
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

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('\n❌ KV environment variables not found.');
    console.error('   Run: vercel link && vercel env pull .env.local\n');
    process.exit(1);
  }

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('\nUsage: node scripts/bulkCreateUsers.js path/to/realtors.csv\n');
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
  const existingUsernames = new Set(users.map((u) => u.username));
  const results = [];

  for (const row of rows) {
    const username = (row.username || '').trim().toLowerCase();
    const displayName = (row.name || row.displayname || '').trim() || username;
    let role = (row.role || 'realtor').trim().toLowerCase();
    let password = (row.password || '').trim();
    let generated = false;

    if (!username) {
      results.push({ username: '', name: displayName, role, password: '', status: 'SKIPPED — missing username' });
      continue;
    }
    if (existingUsernames.has(username)) {
      results.push({ username, name: displayName, role, password: '', status: 'SKIPPED — already exists' });
      continue;
    }
    if (!VALID_ROLES.includes(role)) {
      results.push({ username, name: displayName, role, password: '', status: `SKIPPED — invalid role "${role}"` });
      continue;
    }
    if (!password) {
      password = generatePassword();
      generated = true;
    }
    if (password.length < 8) {
      results.push({ username, name: displayName, role, password: '', status: 'SKIPPED — password must be at least 8 characters' });
      continue;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      username,
      displayName,
      role,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    existingUsernames.add(username);

    results.push({
      username,
      name: displayName,
      role,
      password,
      status: generated ? 'CREATED — password auto-generated' : 'CREATED',
    });
  }

  await saveUsers(users);

  // Write results file with plaintext passwords for one-time distribution.
  const outPath = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + '.results.csv'
  );
  const header = 'username,name,role,password,status';
  const lines = [header, ...results.map((r) =>
    [r.username, r.name, r.role, r.password, r.status].map(toCsvValue).join(',')
  )];
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  console.log('\n=== Bulk user creation summary ===');
  for (const r of results) {
    const marker = r.status.startsWith('CREATED') ? '✅' : '⚠️';
    console.log(`${marker} ${r.username || '(blank)'} — ${r.status}`);
  }
  const createdCount = results.filter((r) => r.status.startsWith('CREATED')).length;
  console.log(`\n${createdCount} of ${rows.length} account(s) created.`);
  console.log(`Full results (including any auto-generated passwords) written to:\n  ${outPath}`);
  console.log('\n⚠️  That file contains plaintext passwords — share credentials securely with each realtor, then delete the file.\n');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
