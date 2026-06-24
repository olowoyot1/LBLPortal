// api/items/index.js
// GET /api/items?name=...  → search items (Property/Item Description autocomplete)
// GET /api/items           → list active items (no query = first 50)
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { searchItems, listItems } from '../_lib/zoho.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const name = (req.query.name || '').trim();
    const items = name ? await searchItems(name) : await listItems();
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
