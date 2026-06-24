// api/bank-accounts/index.js
// GET /api/bank-accounts  → list bank/cash accounts configured in Zoho Books
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { listBankAccounts } from '../_lib/zoho.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const accounts = await listBankAccounts();
    res.json(accounts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
