#!/usr/bin/env node
// Run this locally BEFORE deploying to seed your first users into Vercel KV.
//
// Prerequisites:
//   1. Install Vercel CLI:  npm i -g vercel
//   2. Link your project:   vercel link
//   3. Pull KV env vars:    vercel env pull .env.local
//   4. npm install
//
// Usage:
//   Interactive:      node scripts/createUser.js
//   Non-interactive:  node scripts/createUser.js --username=daniel --name="Daniel Okafor" --password=secret123 --role=admin
//
// Roles: realtor (default), manager, admin

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@vercel/kv';
import bcrypt from 'bcryptjs';
import readline from 'readline/promises';
import { stdin, stdout } from 'process';

// Build KV client from env pulled by `vercel env pull`
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function getUsers() {
  return (await kv.get('users')) ?? [];
}

async function saveUsers(users) {
  await kv.set('users', users);
}

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function createUser({ username, displayName, password, role }) {
  username = (username || '').trim().toLowerCase();
  if (!username) throw new Error('Username is required');

  const users = await getUsers();
  if (users.some((u) => u.username === username)) {
    throw new Error(`User "${username}" already exists`);
  }

  displayName = (displayName || '').trim() || username;
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  role = ['realtor', 'manager', 'admin'].includes(role) ? role : 'realtor';

  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: `u_${Date.now()}`,
    username,
    displayName,
    role,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await saveUsers(users);
  console.log(`\n✅ Created user "${username}" (${displayName}, role: ${role})`);
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('\n❌ KV environment variables not found.');
    console.error('   Run: vercel link && vercel env pull .env.local\n');
    process.exit(1);
  }

  const args = parseArgs();

  if (args.username || args.password) {
    await createUser({ username: args.username, displayName: args.name, password: args.password, role: args.role });
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const username = await rl.question('Username (e.g. daniel): ');
    const displayName = await rl.question('Display name (e.g. Daniel Okafor): ');
    const password = await rl.question('Password (min 8 chars): ');
    const roleInput = await rl.question('Role [realtor/manager/admin] (default realtor): ');
    await createUser({ username, displayName, password, role: roleInput.trim().toLowerCase() });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
