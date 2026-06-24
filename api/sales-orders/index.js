// api/sales-orders/index.js
// GET /api/sales-orders?customerId=...
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { listOpenSalesOrders } from '../_lib/zoho.js';
import { getTransactions } from '../_lib/db.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const customerId = req.query.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const orders = await listOpenSalesOrders(customerId);

    // Zoho doesn't track a running balance on sales orders (that's an
    // invoice-only field) and our top-up payments aren't linked back to
    // the sales order in Zoho, so we compute "amount paid so far" from our
    // own transaction log: the original installment that created the
    // order, plus every top-up recorded against it since.
    const transactions = await getTransactions();
    const enriched = orders.map((order) => {
      const paidSoFar = transactions
        .filter((t) => t.docId === order.salesorder_id || t.soNumber === order.salesorder_number)
        .reduce((sum, t) => sum + (Number(t.amtPaid) || 0), 0);
      const balanceDue = Math.max(0, Number(order.total) - paidSoFar);
      return { ...order, paid_so_far: paidSoFar, balance_due: balanceDue };
    });

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
