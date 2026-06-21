// api/payments/process.js
// POST /api/payments/process
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions, saveTransactions } from '../_lib/db.js';
import * as zoho from '../_lib/zoho.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const {
      custType, txType, customer, newCust, salesOrder,
      propDesc, fullPrice, amtPaid, payDate, payMode,
      payRef, salesperson, notes,
    } = req.body || {};

    if (!txType || !amtPaid || !payDate) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    // Step 1: resolve customer
    let customerId, customerName, customerCreated = false;
    if (custType === 'new') {
      if (!newCust?.name?.trim()) {
        return res.status(400).json({ error: 'New customer name is required' });
      }
      const created = await zoho.createContact({
        name: newCust.name.trim(),
        email: newCust.email,
        phone: newCust.phone,
        address: newCust.address,
      });
      customerId = created.customer_id;
      customerName = created.customer_name;
      customerCreated = true;
    } else {
      if (!customer?.customer_id) {
        return res.status(400).json({ error: 'Existing customer ID is required' });
      }
      customerId = customer.customer_id;
      customerName = customer.customer_name;
    }

    // Step 2: create payment receipt
    const description = `Payment for ${propDesc || (salesOrder?.subject ?? 'property')}${notes ? ' — ' + notes : ''}`;
    const payment = await zoho.createCustomerPayment({
      customerId,
      amount: Number(amtPaid),
      paymentMode: payMode || 'banktransfer',
      date: payDate,
      referenceNumber: payRef,
      description,
    });

    const paymentVerified = await zoho.verifyPaymentExists(payment.payment_id);
    if (!paymentVerified) {
      throw new Error('Payment was created but could not be verified in Zoho Books. Please check Zoho directly before retrying.');
    }

    // Step 3: create matching document
    let docType = 'receipt_only';
    let docId = null;
    let docNumber = null;

    if (txType === 'outright') {
      const notesText = `Full payment received. ${payMode}${payRef ? ' Ref: ' + payRef : ''}${notes ? ' — ' + notes : ''}`;
      const invoice = await zoho.createInvoice({
        customerId, date: payDate, lineItemName: propDesc, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifyInvoiceExists(invoice.invoice_id);
      if (!verified) throw new Error('Invoice was created but could not be verified. Check Zoho Books directly.');
      docType = 'invoice'; docId = invoice.invoice_id; docNumber = invoice.invoice_number;

    } else if (txType === 'installment') {
      const notesText = `Installment plan. Initial deposit NGN ${Number(amtPaid).toLocaleString()} on ${payDate} via ${payMode}${payRef ? ' Ref: ' + payRef : ''}${notes ? ' — ' + notes : ''}`;
      const so = await zoho.createSalesOrder({
        customerId, date: payDate, lineItemName: propDesc, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifySalesOrderExists(so.salesorder_id);
      if (!verified) throw new Error('Sales order was created but could not be verified. Check Zoho Books directly.');
      docType = 'sales_order'; docId = so.salesorder_id; docNumber = so.salesorder_number;

    } else if (txType === 'topup') {
      if (!salesOrder?.salesorder_id) {
        return res.status(400).json({ error: 'Sales order is required for a top-up payment' });
      }
      docNumber = salesOrder.salesorder_number;
    }

    // Step 4: append to transaction log in KV
    const entry = {
      id: `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      realtor: session.displayName,
      realtorUsername: session.username,
      custName: customerName,
      custId: customerId,
      custCreated: customerCreated,
      txType,
      propDesc: propDesc || salesOrder?.subject || '',
      amtPaid: Number(amtPaid),
      fullPrice: Number(fullPrice || 0),
      payMode,
      payRef: payRef || '',
      docType,
      docId,
      docNumber,
      paymentId: payment.payment_id,
      soNumber: txType === 'topup' ? salesOrder.salesorder_number : null,
    };

    const transactions = await getTransactions();
    transactions.unshift(entry);
    await saveTransactions(transactions);

    res.json({ success: true, ...entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
