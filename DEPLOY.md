# Landblaze Payment Portal — Vercel Deployment Guide

## What changed from the original

| Original | Vercel version |
|---|---|
| `lowdb` writing to `data/db.json` on disk | **Vercel KV** (Redis) — persists across all deployments |
| Express server (`npm start`) | **Vercel Serverless Functions** in `api/` |
| Separate frontend + backend servers | **Single Vercel project** — frontend in `public/`, API in `api/` |
| `frontend/config.js` pointed at `localhost:4000` | `API_BASE_URL = ''` — relative URL, same domain |

---

## Step 1 — Set up Vercel KV

1. Push this folder to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import your repo.
3. In your Vercel project dashboard, go to **Storage** → **Create Database** → **KV**.
4. Name it anything (e.g. `landblaze-kv`). Vercel automatically adds the KV env vars to your project.

## Step 2 — Add environment variables

In Vercel dashboard → **Settings** → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `ZOHO_CLIENT_ID` | From api-console.zoho.com |
| `ZOHO_CLIENT_SECRET` | From api-console.zoho.com |
| `ZOHO_REFRESH_TOKEN` | From the curl exchange (see original SETUP.md) |
| `ZOHO_ORG_ID` | `893544348` (or your org ID from Zoho Books) |
| `NODE_ENV` | `production` |

KV vars (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) are added automatically by Vercel when you attach the KV store.

## Step 3 — Create user accounts (before or after deploy)

Install the Vercel CLI and pull your KV credentials locally:

```bash
npm install -g vercel
vercel link          # link to your Vercel project
vercel env pull .env.local   # pulls KV vars to .env.local
npm install
node scripts/createUser.js   # interactive — repeat for each staff member
```

Or non-interactively:
```bash
node scripts/createUser.js --username=daniel --name="Daniel Okafor" --password=MyPass123 --role=admin
```

Roles: `realtor` (default), `manager`, `admin`. Only manager/admin can clear the transaction log.

## Step 4 — Deploy

Either push to GitHub (Vercel auto-deploys on every push), or:

```bash
vercel --prod
```

Your portal will be live at `https://your-project.vercel.app`.

---

## Zoho credentials (if you haven't done this yet)

1. Go to [api-console.zoho.com](https://api-console.zoho.com) → **Add Client** → **Self Client**
2. Scope: `ZohoBooks.fullaccess.all`, duration: 10 minutes
3. Copy the **Client ID**, **Client Secret**, and the one-time **authorization code**
4. Exchange for a refresh token:

```bash
curl -X POST https://accounts.zoho.com/oauth/v2/token \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://www.zoho.com" \
  -d "code=THE_AUTHORIZATION_CODE"
```

The `refresh_token` in the response is what goes in your Vercel env vars. It does not expire unless revoked.
