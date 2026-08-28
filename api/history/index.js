// api/history/index.js
// Backfill historical customer payments directly into Zoho Books as Sales Receipts.
// Each row is a real accounting transaction: customer + item + amount + date + bank account.
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions, saveTransactions } from '../_lib/db.js';
import * as zoho from '../_lib/zoho.js';

function cleanRow(row) {
  return {
    amount: Number(row?.amount),
    date: String(row?.date || '').trim(),
    itemId: String(row?.itemId || '').trim(),
    itemName: String(row?.itemName || '').trim(),
    bankAccountId: String(row?.bankAccountId || '').trim(),
    bankAccountName: String(row?.bankAccountName || '').trim(),
    paymentMode: String(row?.paymentMode || 'banktransfer').trim(),
    referenceNumber: String(row?.referenceNumber || '').trim(),
    notes: String(row?.notes || '').trim(),
  };
}

function stableHash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

function makeReference(customerId, row, duplicateOrdinal = 1) {
  const fingerprint = [
    customerId, row.date, row.amount.toFixed(2), row.itemId || row.itemName,
    row.bankAccountId, row.paymentMode, row.notes
  ].join('|');
  return `LBP-HIST-${stableHash(fingerprint)}-${String(duplicateOrdinal).padStart(2, '0')}`;
}

function validateRow(r, index) {
  const missing = [];
  if (!Number.isFinite(r.amount) || r.amount <= 0) missing.push('amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) missing.push('date');
  if (!r.itemId && !r.itemName) missing.push('item');
  if (!r.bankAccountId) missing.push('bank account');
  if (missing.length) throw new Error(`History row ${index + 1}: missing/invalid ${missing.join(', ')}`);
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const { customer, rows } = req.body || {};
    if (!customer?.customer_id) return res.status(400).json({ error: 'A Zoho customer is required.' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Add at least one historical payment.' });
    if (rows.length > 100) return res.status(400).json({ error: 'You can post a maximum of 100 historical payments at once.' });

    const cleaned = rows.map(cleanRow);
    cleaned.forEach(validateRow);

    const transactions = await getTransactions();
    const duplicateCounts = new Map();
    const results = [];

    for (let i = 0; i < cleaned.length; i++) {
      const r = cleaned[i];
      try {
        const fingerprint = [
          customer.customer_id, r.date, r.amount.toFixed(2), r.itemId || r.itemName,
          r.bankAccountId, r.paymentMode, r.notes
        ].join('|');
        const ordinal = (duplicateCounts.get(fingerprint) || 0) + 1;
        duplicateCounts.set(fingerprint, ordinal);
        const autoReference = makeReference(customer.customer_id, r, ordinal);

        // Idempotency: if this exact generated reference was already posted, reuse it
        // instead of creating a duplicate Zoho Sales Receipt. This protects retries
        // after browser refreshes, Vercel timeouts, or partial batch failures.
        const localExisting = transactions.find(t => t.referenceNumber === autoReference);
        let existing = localExisting ? {
          sales_receipt_id: localExisting.salesReceiptId || localExisting.docId,
          receipt_number: localExisting.docNumber || ''
        } : null;
        if (!existing?.sales_receipt_id) {
          const zohoExisting = await zoho.findSalesReceiptByReference(autoReference);
          if (zohoExisting) existing = {
            sales_receipt_id: zohoExisting.sales_receipt_id,
            receipt_number: zohoExisting.receipt_number || ''
          };
        }

        const notes = [
          'Historical payment backfilled through Landblaze Payment Portal.',
          `Portal Reference: ${autoReference}.`,
          r.notes,
        ].filter(Boolean).join(' ');

        const receipt = existing || await zoho.createSalesReceipt({
          customerId: customer.customer_id,
          amount: r.amount,
          paymentMode: r.paymentMode || 'banktransfer',
          accountId: r.bankAccountId,
          date: r.date,
          itemId: r.itemId || undefined,
          lineItemName: r.itemName || 'Historical payment',
          notes,
          referenceNumber: autoReference,
        });

        const verified = await zoho.verifySalesReceiptExists(receipt.sales_receipt_id);
        if (!verified) throw new Error('Sales receipt was created but could not be verified in Zoho Books.');

        const entry = {
          id: `hist_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date(`${r.date}T12:00:00`).toISOString(),
          recordedAt: new Date().toISOString(),
          isLegacy: false,
          isHistorical: true,
          realtor: session.displayName,
          realtorUsername: session.username,
          realtorEmail: session.email || '',
          custName: customer.customer_name,
          custId: customer.customer_id,
          custEmail: customer.email || '',
          custCreated: false,
          txType: 'historical',
          propDesc: r.itemName || 'Historical payment',
          plotSize: '',
          amtPaid: r.amount,
          fullPrice: 0,
          payMode: r.paymentMode || 'banktransfer',
          bankAccountName: r.bankAccountName || '',
          bankAccountId: r.bankAccountId,
          referenceNumber: autoReference,
          notes: r.notes || '',
          docType: 'sales_receipt',
          docId: receipt.sales_receipt_id,
          docNumber: receipt.receipt_number,
          contractCode: null,
          paymentId: null,
          salesReceiptId: receipt.sales_receipt_id,
          soNumber: null,
          finalPayment: false,
          docsSent: ['Historical Sales Receipt'],
          emailSent: false,
          emailErrors: [],
          idempotencyReused: Boolean(existing),
        };

        transactions.unshift(entry);
        results.push({
          ok: true,
          row: i,
          amount: r.amount,
          date: r.date,
          itemName: r.itemName,
          bankAccountName: r.bankAccountName,
          receiptId: receipt.sales_receipt_id,
          receiptNumber: receipt.receipt_number,
          referenceNumber: autoReference,
          reusedExisting: Boolean(existing),
        });
      } catch (e) {
        results.push({ ok: false, row: i, error: e.message });
      }
    }

    if (results.some((r) => r.ok)) await saveTransactions(transactions);

    res.json({
      success: results.every((r) => r.ok),
      customerId: customer.customer_id,
      posted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
