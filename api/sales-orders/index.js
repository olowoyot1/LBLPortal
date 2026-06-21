// api/sales-orders/index.js
// GET /api/sales-orders?customerId=...
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { listOpenSalesOrders } from '../_lib/zoho.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const customerId = req.query.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const orders = await listOpenSalesOrders(customerId);
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
