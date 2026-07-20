// api/contracts/resend.js
// POST /api/contracts/resend  { transactionId }
// Re-sends the customer-facing documents for ANY past transaction — an
// invoice or sales order (regenerating and re-attaching the Contract of
// Sale + Deed of Assignment), or a top-up's payment receipt (rebuilding
// its payment-history table). Used by the "Resend Documents" button in
// the transaction log for cases where the original send failed, the
// customer lost the email, or details needed a manual correction in Zoho
// Books before resending.
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions, saveTransactions } from '../_lib/db.js';
import * as zoho from '../_lib/zoho.js';
import { buildContractPdf } from '../_lib/contract.js';
import { buildDeedOfAssignmentPdf } from '../_lib/deed.js';
import { buildPaymentHistoryTable } from '../_lib/paymentHistory.js';
import { generateContractCode } from '../_lib/contractCode.js';
import { attachContract, attachDeed } from '../_lib/documents.js';

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

    if (!tx.custEmail) {
      return res.status(400).json({ error: 'This customer has no email on file. Add one in Zoho Books before resending.' });
    }

    // CC everyone who was on the original transaction (the realtor who
    // processed it, plus any manually-entered realtor emails), so a
    // resend reaches the same people as the original send did.
    const ccEmail = tx.realtorEmail || session.email || '';

    // ── Top-ups: resend the payment receipt (with its payment-history
    // table rebuilt from the current log) — there's no invoice/sales
    // order attached directly to a top-up itself. ──
    if (tx.docType === 'receipt_only' || !tx.docId) {
      if (!tx.paymentId) {
        return res.status(400).json({ error: 'This transaction has no payment on record to resend a receipt for.' });
      }

      let paymentHistoryHtml = null;
      if (tx.soNumber) {
        const related = transactions.filter((t) => t.soNumber === tx.soNumber || t.docNumber === tx.soNumber);
        const priorPayments = related.filter((t) => t.id !== tx.id && new Date(t.timestamp) <= new Date(tx.timestamp));
        const contractTotal = related.find((t) => t.docType === 'sales_order')?.fullPrice || tx.fullPrice;
        const { html } = buildPaymentHistoryTable({
          priorPayments,
          newPayment: { date: tx.timestamp, amount: tx.amtPaid, mode: tx.payMode },
          contractTotal,
          soNumber: tx.soNumber,
        });
        paymentHistoryHtml = html;
      }

      await zoho.sendPaymentReceiptEmail(tx.paymentId, {
        email: tx.custEmail,
        ccEmail,
        paymentNumber: tx.docNumber || tx.paymentId,
        extraBodyHtml: paymentHistoryHtml,
      });

      return res.json({ success: true, custEmail: tx.custEmail, docNumber: tx.docNumber || tx.paymentId, docsSent: ['Payment Receipt'] });
    }

    // ── Invoices / sales orders: regenerate the Contract of Sale, attach
    // it plus the Deed of Assignment, and resend the document email. ──
    if (tx.docType !== 'invoice' && tx.docType !== 'sales_order') {
      return res.status(400).json({ error: `Cannot resend documents for transaction type "${tx.docType}".` });
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

    // Older transactions (created before contract codes existed) won't
    // have one stored — generate one now and persist it back to the log
    // so the code stays stable across any future resends of this same
    // transaction, rather than minting a new one every time.
    let contractCode = tx.contractCode;
    if (!contractCode) {
      contractCode = await generateContractCode(tx.timestamp);
      const idx = transactions.findIndex((t) => t.id === tx.id);
      if (idx !== -1) {
        transactions[idx] = { ...transactions[idx], contractCode };
        await saveTransactions(transactions);
      }
    }

    const contractPdf = await buildContractPdf({
      customerName: tx.custName,
      customerAddress,
      propertyDescription: tx.propDesc,
      plotSize: tx.plotSize,
      fullPrice: tx.fullPrice,
      amountPaid: tx.amtPaid,
      contractDate: tx.timestamp,
      documentNumber: tx.docNumber,
      contractCode,
      deedAttached: Boolean(tx.finalPayment) || tx.docType === 'invoice',
    });

    const docKind = tx.docType === 'invoice' ? 'invoice' : 'salesorder';
    await attachContract({ docKind, docId: tx.docId, contractPdf });
    const docsSent = ['Contract of Sale'];

    // Only re-attach the Deed of Conveyance if this transaction was
    // originally recorded as the final payment — resending must not hand
    // out an ownership-transfer document for a sale that isn't actually
    // fully paid off. Older invoice-type transactions predate the
    // finalPayment field but were always outright (=always final) sales.
    if (tx.finalPayment || tx.docType === 'invoice') {
      const deedPdf = await buildDeedOfAssignmentPdf({
        customerName: tx.custName,
        customerAddress,
        propertyDescription: tx.propDesc,
        plotSize: tx.plotSize,
        considerationAmount: tx.fullPrice,
        documentNumber: tx.docNumber,
        contractCode,
        deedDate: tx.timestamp,
      });
      await attachDeed({ docKind, docId: tx.docId, deedPdf });
      docsSent.push('Deed of Conveyance');
    }

    if (tx.docType === 'invoice') {
      await zoho.sendInvoiceEmail(tx.docId, { email: tx.custEmail, ccEmail, invoiceNumber: tx.docNumber, sendAttachment: true, contractCode });
    } else {
      await zoho.sendSalesOrderEmail(tx.docId, { email: tx.custEmail, ccEmail, salesorderNumber: tx.docNumber, sendAttachment: true, contractCode });
    }

    res.json({ success: true, custEmail: tx.custEmail, docNumber: tx.docNumber, contractCode, docsSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
