// LBL Portal ↔ Blaze Engine bridge.
// Secrets stay server-side: BLAZE_ENGINE_URL and BLAZE_ENGINE_SECRET must be
// configured in Vercel. The browser never receives the integration secret.
import { requireAuth } from './_lib/auth.js';
import { handleCors } from './_lib/cors.js';

function baseUrl() {
  return String(process.env.BLAZE_ENGINE_URL || 'https://blazeengine.vercel.app').replace(/\/$/, '');
}

function configured() {
  return Boolean(process.env.BLAZE_ENGINE_URL && process.env.BLAZE_ENGINE_SECRET);
}

async function callBlaze(path, options = {}) {
  if (!configured()) throw new Error('Blaze Engine integration is not configured in this Vercel project');
  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.BLAZE_ENGINE_SECRET}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `Blaze Engine request failed (${res.status})`);
  return body;
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  const session = await requireAuth(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      if (!['accountant', 'finance_operations', 'sales_manager', 'manager', 'admin'].includes(String(session.role).toLowerCase())) {
        return res.status(403).json({ error: 'Your LBL Portal role cannot access Blaze Engine sales workflow.' });
      }
      const status = String(req.query.status || 'PAYMENT_PROOF_SUBMITTED,INVOICE_ENTERED,SALES_APPROVED');
      const data = await callBlaze(`/api/integrations/lbl?status=${encodeURIComponent(status)}`);
      return res.json(data);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { action, saleId } = req.body || {};
    if (!saleId || !action) return res.status(400).json({ error: 'saleId and action are required' });

    const data = await callBlaze('/api/integrations/lbl', {
      method: 'POST',
      body: JSON.stringify({ action, saleId, email: session.email }),
    });
    return res.json(data);
  } catch (err) {
    console.error('Blaze bridge error', err);
    return res.status(400).json({ error: err.message || 'Blaze Engine integration failed' });
  }
}
