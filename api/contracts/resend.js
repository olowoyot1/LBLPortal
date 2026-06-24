// api/contracts/resend.js
// POST /api/contracts/resend  { transactionId }
// Regenerates the customized Contract of Sale for a past transaction and
// re-attaches + re-sends it to the customer. Used by the "Resend Contract"
// button in the transaction log for cases where the original send failed,
// the customer lost the email, or details needed a manual correction in
// Zoho Books before resending.
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions } from '../_lib/db.js';
import * as zoho from '../_lib/zoho.js';
import { buildContractPdf } from '../_lib/contract.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const { transactionId } = req.body || {};
    if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

    const transactions = await getTransactions();
    const tx = transactions.find((t) => t.id === transactionId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    if (tx.docType !== 'invoice' && tx.docType !== 'sales_order') {
      return res.status(400).json({ error: 'This transaction has no invoice or sales order to attach a contract to (top-ups do not carry their own contract — see the original installment/outright transaction).' });
    }
    if (!tx.docId) {
      return res.status(400).json({ error: 'This transaction has no document ID on record.' });
    }
    if (!tx.custEmail) {
      return res.status(400).json({ error: 'This customer has no email on file. Add one in Zoho Books before resending.' });
    }

    // Look up the customer's billing address fresh — it may have been
    // corrected in Zoho Books since the original transaction.
    let customerAddress = '';
    try {
      const full = await zoho.getContact(tx.custId);
      customerAddress = full.address || '';
    } catch (e) {
      customerAddress = '';
    }

    const contractPdf = await buildContractPdf({
      customerName: tx.custName,
      customerAddress,
      propertyDescription: tx.propDesc,
      fullPrice: tx.fullPrice,
      amountPaid: tx.amtPaid,
      contractDate: tx.timestamp,
      documentNumber: tx.docNumber,
    });

    if (tx.docType === 'invoice') {
      await zoho.attachContractToInvoice(tx.docId, contractPdf);
      await zoho.sendInvoiceEmail(tx.docId, { email: tx.custEmail, invoiceNumber: tx.docNumber, sendAttachment: true });
    } else {
      await zoho.attachContractToSalesOrder(tx.docId, contractPdf);
      await zoho.sendSalesOrderEmail(tx.docId, { email: tx.custEmail, salesorderNumber: tx.docNumber, sendAttachment: true });
    }

    res.json({ success: true, custEmail: tx.custEmail, docNumber: tx.docNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
