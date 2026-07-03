# License / Subscription Gate

The app now refuses to work (login blocked, all authenticated API calls blocked
with a 402 response) unless a valid, unexpired license is present. There are
two modes.

## Local mode (default — works out of the box)

The license lives in this project's own Vercel KV, under the key `license`.

**Set it up / renew monthly:**
```bash
vercel link
vercel env pull .env.local
npm install
node scripts/setLicense.js --days=30
```

**Check status without changing anything:**
```bash
node scripts/setLicense.js --status-only
```

**Suspend immediately (e.g. non-payment), without deleting user data:**
```bash
node scripts/setLicense.js --status=suspended
```

If `scripts/setLicense.js` has never been run, there's no `license` record in
KV at all, and the app is locked out by default — nobody can log in until
someone runs it.

**Important limitation:** this only really protects you if you are the one
who controls the Vercel project (and its KV) that the app is deployed to.
Since the enforcement code ships as part of the app's own source, anyone who
has full access to that Vercel project could edit the KV record directly, or
delete `requireLicense(...)` from the code, and remove the restriction. This
mode is fine for gating your own usage, or for clients you trust not to open
the code — it is not tamper-proof DRM.

## Remote mode (recommended if you deploy/sell copies of this app)

Set these two environment variables in each client's Vercel project instead:

| Variable | Value |
|---|---|
| `LICENSE_SERVER_URL` | The base URL of a license-verification server *you* host and control |
| `LICENSE_KEY` | A unique key issued to that specific client/installation |

When `LICENSE_SERVER_URL` is set, the app calls `POST {LICENSE_SERVER_URL}/verify`
with `{ "licenseKey": "..." }` on every check (cached for up to an hour) and
expects back:
```json
{ "valid": true, "validUntil": "2026-08-03", "plan": "standard" }
```
or
```json
{ "valid": false, "reason": "Subscription expired" }
```

Because that server and its database are yours — not shipped to the client —
they can't extend their own subscription by editing their copy of the code or
their own KV. This is the version worth building if you plan to resell.

**This remote server is not included yet.** It only needs to be a couple of
tiny endpoints (`/verify`, plus something for you to create/renew/revoke keys)
backed by any small database. If you decide to go the reseller route, let me
know and I'll build that as a separate small project.
