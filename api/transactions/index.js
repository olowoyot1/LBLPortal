// api/transactions/index.js
// GET    /api/transactions  → list all
// DELETE /api/transactions  → clear (manager/admin only)
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions, saveTransactions } from '../_lib/db.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const transactions = await getTransactions();
      return res.json(transactions);
    }

    if (req.method === 'DELETE') {
      if (session.role !== 'admin' && session.role !== 'manager') {
        return res.status(403).json({ error: 'Only managers or admins can clear the transaction log' });
      }
      await saveTransactions([]);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
