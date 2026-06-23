// api/payments/process.js
// POST /api/payments/process
import { handleCors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { getTransactions, saveTransactions } from '../_lib/db.js';
import * as zoho from '../_lib/zoho.js';
import { buildContractPdf } from '../_lib/contract.js';
import { buildPaymentHistoryTable } from '../_lib/paymentHistory.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await requireAuth(req, res);
    if (!session) return;

    const {
      custType, txType, customer, newCust, salesOrder,
      propDesc, item, fullPrice, amtPaid, payDate, payMode,
      bankAccount, payRef, salesperson, notes,
    } = req.body || {};

    if (!txType || !amtPaid || !payDate) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    // Step 1: resolve customer
    let customerId, customerName, customerEmail, customerAddress = '', customerCreated = false;
    if (custType === 'new') {
      const missing = [];
      if (!newCust?.name?.trim()) missing.push('name');
      if (!newCust?.email?.trim()) missing.push('email');
      if (!newCust?.phone?.trim()) missing.push('phone');
      if (!newCust?.address?.trim()) missing.push('address');
      if (missing.length) {
        return res.status(400).json({ error: `New customer is missing required field(s): ${missing.join(', ')}` });
      }
      const created = await zoho.createContact({
        name: newCust.name.trim(),
        email: newCust.email.trim(),
        phone: newCust.phone.trim(),
        address: newCust.address.trim(),
      });
      customerId = created.customer_id;
      customerName = created.customer_name;
      customerEmail = created.email;
      customerAddress = newCust.address.trim();
      customerCreated = true;
    } else {
      if (!customer?.customer_id) {
        return res.status(400).json({ error: 'Existing customer ID is required' });
      }
      customerId = customer.customer_id;
      customerName = customer.customer_name;
      customerEmail = customer.email;
      // Existing-customer search results don't carry a billing address —
      // fetch it for the contract PDF. Non-fatal if it fails; the contract
      // will just omit the address line rather than block the payment.
      try {
        const full = await zoho.getContact(customerId);
        customerAddress = full.address || '';
      } catch (e) {
        customerAddress = '';
      }
    }

    // Step 2: create payment receipt
    const itemLabel = (item?.name || propDesc || salesOrder?.subject || 'property');
    const description = `Payment for ${itemLabel}${notes ? ' — ' + notes : ''}`;
    const payment = await zoho.createCustomerPayment({
      customerId,
      amount: Number(amtPaid),
      paymentMode: payMode || 'banktransfer',
      accountId: bankAccount?.account_id,
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
    let emailSent = false;
    const emailErrors = [];

    if (txType === 'outright') {
      const notesText = `Full payment received. ${payMode}${payRef ? ' Ref: ' + payRef : ''}${notes ? ' — ' + notes : ''}`;
      const invoice = await zoho.createInvoice({
        customerId, date: payDate, itemId: item?.item_id, lineItemName: itemLabel, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifyInvoiceExists(invoice.invoice_id);
      if (!verified) throw new Error('Invoice was created but could not be verified. Check Zoho Books directly.');
      docType = 'invoice'; docId = invoice.invoice_id; docNumber = invoice.invoice_number;

      // Generate the customized Contract of Sale and attach it to the
      // invoice so it goes out as a real attachment on the same email —
      // non-blocking: a contract failure shouldn't stop the sale itself.
      try {
        const contractPdf = await buildContractPdf({
          customerName, customerAddress, propertyDescription: itemLabel,
          fullPrice: Number(fullPrice), amountPaid: Number(amtPaid),
          contractDate: payDate, documentNumber: invoice.invoice_number,
        });
        await zoho.attachContractToInvoice(invoice.invoice_id, contractPdf);
      } catch (e) {
        emailErrors.push(`Contract generation: ${e.message}`);
      }

      // Send the invoice to the customer (emails their copy) and
      // explicitly mark it as sent — this is what moves it out of draft
      // status in Zoho Books. Done independently so a failed email
      // doesn't leave the invoice stuck in Draft.
      try {
        await zoho.sendInvoiceEmail(invoice.invoice_id, { email: customerEmail, invoiceNumber: invoice.invoice_number, sendAttachment: true });
        emailSent = true;
      } catch (e) {
        emailErrors.push(`Invoice email: ${e.message}`);
      }
      try {
        await zoho.markInvoiceSent(invoice.invoice_id);
      } catch (e) {
        emailErrors.push(`Invoice status update: ${e.message}`);
      }

    } else if (txType === 'installment') {
      const notesText = `Installment plan. Initial deposit NGN ${Number(amtPaid).toLocaleString()} on ${payDate} via ${payMode}${payRef ? ' Ref: ' + payRef : ''}${notes ? ' — ' + notes : ''}`;
      const so = await zoho.createSalesOrder({
        customerId, date: payDate, itemId: item?.item_id, lineItemName: itemLabel, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifySalesOrderExists(so.salesorder_id);
      if (!verified) throw new Error('Sales order was created but could not be verified. Check Zoho Books directly.');
      docType = 'sales_order'; docId = so.salesorder_id; docNumber = so.salesorder_number;

      // Same as outright: generate and attach the customized contract,
      // non-blocking on failure.
      try {
        const contractPdf = await buildContractPdf({
          customerName, customerAddress, propertyDescription: itemLabel,
          fullPrice: Number(fullPrice), amountPaid: Number(amtPaid),
          contractDate: payDate, documentNumber: so.salesorder_number,
        });
        await zoho.attachContractToSalesOrder(so.salesorder_id, contractPdf);
      } catch (e) {
        emailErrors.push(`Contract generation: ${e.message}`);
      }

      // Send the sales order to the customer (emails their copy) and
      // explicitly mark it as Open — sales orders use Draft/Open/Closed/Void
      // in Zoho Books (not "sent"). Done independently so a failed email
      // doesn't leave the order stuck in Draft.
      try {
        await zoho.sendSalesOrderEmail(so.salesorder_id, { email: customerEmail, salesorderNumber: so.salesorder_number, sendAttachment: true });
        emailSent = true;
      } catch (e) {
        emailErrors.push(`Sales order email: ${e.message}`);
      }
      try {
        await zoho.markSalesOrderOpen(so.salesorder_id);
      } catch (e) {
        emailErrors.push(`Sales order status update: ${e.message}`);
      }

    } else if (txType === 'topup') {
      if (!salesOrder?.salesorder_id) {
        return res.status(400).json({ error: 'Sales order is required for a top-up payment' });
      }
      docNumber = salesOrder.salesorder_number;
    }
    // Fetch the transaction log now (needed below both to compute the
    // top-up running balance for the receipt email, and to append this
    // entry once processing completes).
    const transactions = await getTransactions();

    // For top-ups, find every prior transaction tied to this sales order so
    // we can build the payment-history table embedded in the receipt email,
    // and compute the new remaining balance (Zoho doesn't track a running
    // balance on sales orders itself — see listOpenSalesOrders).
    let soRemainingBalance = null;
    let paymentHistoryHtml = null;
    if (txType === 'topup') {
      const priorPayments = transactions.filter(
        (t) => t.docId === salesOrder.salesorder_id || t.soNumber === salesOrder.salesorder_number
      );
      const priorPaid = priorPayments.reduce((sum, t) => sum + (Number(t.amtPaid) || 0), 0);
      soRemainingBalance = Math.max(0, Number(salesOrder.total) - priorPaid - Number(amtPaid));

      const { html } = buildPaymentHistoryTable({
        priorPayments,
        newPayment: { date: payDate, amount: Number(amtPaid), mode: payMode, ref: payRef },
        contractTotal: Number(salesOrder.total),
        soNumber: salesOrder.salesorder_number,
      });
      paymentHistoryHtml = html;
    }

    // Every transaction — receipt-only top-ups included — emails the
    // customer their payment receipt. Top-ups additionally get the full
    // payment-history table embedded in the email body.
    try {
      await zoho.sendPaymentReceiptEmail(payment.payment_id, {
        email: customerEmail,
        paymentNumber: payment.payment_number,
        extraBodyHtml: paymentHistoryHtml,
      });
      emailSent = true;
    } catch (e) {
      emailErrors.push(`Receipt email: ${e.message}`);
    }

    // Step 4: append to transaction log in KV
    const entry = {
      id: `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      realtor: session.displayName,
      realtorUsername: session.username,
      custName: customerName,
      custId: customerId,
      custEmail: customerEmail || '',
      custCreated: customerCreated,
      txType,
      propDesc: itemLabel,
      amtPaid: Number(amtPaid),
      fullPrice: Number(fullPrice || 0),
      payMode,
      bankAccountName: bankAccount?.account_name || '',
      payRef: payRef || '',
      docType,
      docId,
      docNumber,
      paymentId: payment.payment_id,
      soNumber: txType === 'topup' ? salesOrder.salesorder_number : null,
      emailSent,
      emailErrors,
    };

    transactions.unshift(entry);
    await saveTransactions(transactions);

    res.json({ success: true, ...entry, soRemainingBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
