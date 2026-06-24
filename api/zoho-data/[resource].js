// api/zoho-data/[resource].js
// Consolidated read-mostly Zoho-backed lookups, kept in one Serverless
// Function to stay under the Vercel Hobby plan's 12-function cap.
//
// Public URLs are unchanged (mapped via vercel.json rewrites):
//   GET  /api/bank-accounts              -> resource=bank-accounts
//   GET  /api/customers?name=...         -> resource=customers
//   POST /api/customers                  -> resource=customers
//   GET  /api/items?name=...             -> resource=items
//   GET  /api/sales-orders?customerId=.. -> resource=sales-orders
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions } from '../_lib/db.js';
import {
  listBankAccounts,
  searchContacts,
  createContact,
  searchItems,
  listItems,
  listOpenSalesOrders,
} from '../_lib/zoho.js';

async function bankAccounts(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const accounts = await listBankAccounts();
  res.json(accounts);
}

async function customers(req, res) {
  if (req.method === 'GET') {
    const name = (req.query.name || '').trim();
    if (!name) return res.json([]);
    const results = await searchContacts(name);
    return res.json(results);
  }

  if (req.method === 'POST') {
    const { name, email, phone, address } = req.body || {};
    const missing = [];
    if (!name?.trim()) missing.push('name');
    if (!email?.trim()) missing.push('email');
    if (!phone?.trim()) missing.push('phone');
    if (!address?.trim()) missing.push('address');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }
    const customer = await createContact({ name: name.trim(), email: email.trim(), phone: phone.trim(), address: address.trim() });
    return res.json(customer);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function items(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const name = (req.query.name || '').trim();
  const results = name ? await searchItems(name) : await listItems();
  res.json(results);
}

async function salesOrders(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const { resource } = req.query;

    switch (resource) {
      case 'bank-accounts':
        return await bankAccounts(req, res);
      case 'customers':
        return await customers(req, res);
      case 'items':
        return await items(req, res);
      case 'sales-orders':
        return await salesOrders(req, res);
      default:
        return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
