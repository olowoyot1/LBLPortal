// api/customers/index.js
// GET  /api/customers?name=...  → search
// POST /api/customers           → create
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { searchContacts, createContact } from '../_lib/zoho.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

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

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
