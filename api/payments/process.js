// api/payments/process.js
// POST /api/payments/process
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

    const {
      custType, txType, customer, newCust, salesOrder,
      propDesc, plotSize, item, fullPrice, amtPaid, payDate, payMode,
      bankAccount, salesperson, notes, realtorEmails, finalPayment, legacyPayment,
    } = req.body || {};

    if (!txType || !amtPaid || !payDate) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    // A legacy/historical payment records a payment the customer made
    // BEFORE this portal existed, against a sales order that already
    // exists in Zoho. It's a portal-only adjustment: no Zoho payment, no
    // document, no email — just an entry in the local transaction log so
    // every balance calculation and payment-history table accounts for
    // it going forward. Only meaningful for top-ups (an existing sales
    // order must already be selected).
    const isLegacyEntry = txType === 'topup' && Boolean(legacyPayment);

    // Manually-entered realtor email(s) (comma-separated in the form) are
    // combined with the logged-in staff member's own email — everyone who
    // should be CC'd on every document/receipt for this transaction.
    const manualRealtorEmails = String(realtorEmails || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const ccList = [...new Set([session.email, ...manualRealtorEmails].filter(Boolean))];
    const realtorEmailForLog = ccList.join(', ');

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

    // Step 2: create payment receipt — skipped entirely for a legacy
    // entry, since it must never create anything in Zoho.
    const itemLabel = (item?.name || propDesc || salesOrder?.subject || 'property');
    const description = `Payment for ${itemLabel}${notes ? ' — ' + notes : ''}`;
    let payment = null;
    if (!isLegacyEntry) {
      payment = await zoho.createCustomerPayment({
        customerId,
        amount: Number(amtPaid),
        paymentMode: payMode || 'banktransfer',
        accountId: bankAccount?.account_id,
        date: payDate,
        description,
      });

      const paymentVerified = await zoho.verifyPaymentExists(payment.payment_id);
      if (!paymentVerified) {
        throw new Error('Payment was created but could not be verified in Zoho Books. Please check Zoho directly before retrying.');
      }
    }

    // Step 3: create matching document
    let docType = isLegacyEntry ? 'legacy' : 'receipt_only';
    let docId = null;
    let docNumber = null;
    let emailSent = false;
    const emailErrors = [];

    let contractCode = null;
    // Tracks whether this payment settles the property in full — always
    // true for outright sales; for installments/top-ups it's either
    // detected automatically (balance reaches zero) or forced via the
    // "final payment" toggle in the form. Drives whether the full
    // document bundle (Contract of Sale + Deed of Assignment, and for
    // top-ups the sales order itself) goes out with this payment. Never
    // applies to a legacy entry — it never triggers document sending
    // regardless of the resulting balance.
    let isFinalPayment = false;
    let docsSent = isLegacyEntry ? ['Legacy Payment Recorded (portal only)'] : ['Payment Receipt'];

    if (txType === 'outright') {
      isFinalPayment = true;
      const notesText = `Full payment received. ${payMode}${notes ? ' — ' + notes : ''}`;
      const invoice = await zoho.createInvoice({
        customerId, date: payDate, itemId: item?.item_id, lineItemName: itemLabel, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifyInvoiceExists(invoice.invoice_id);
      if (!verified) throw new Error('Invoice was created but could not be verified. Check Zoho Books directly.');
      docType = 'invoice'; docId = invoice.invoice_id; docNumber = invoice.invoice_number;

      // Generate the customized Contract of Sale and attach it — every
      // sale gets this. An outright purchase is always fully paid at
      // inception, so the Deed of Conveyance (ownership transfer) also
      // goes out immediately, per Landblaze's own contract terms ("...
      // Deed of Assignment ... upon full settlement of the purchase
      // price"). Non-blocking: a document failure shouldn't stop the sale
      // itself.
      try {
        contractCode = await generateContractCode(payDate);
        const contractPdf = await buildContractPdf({
          customerName, customerAddress, propertyDescription: itemLabel, plotSize,
          fullPrice: Number(fullPrice), amountPaid: Number(amtPaid),
          contractDate: payDate, documentNumber: invoice.invoice_number, contractCode,
          deedAttached: true,
        });
        await attachContract({ docKind: 'invoice', docId: invoice.invoice_id, contractPdf });
        docsSent.push('Invoice', 'Contract of Sale');

        const deedPdf = await buildDeedOfAssignmentPdf({
          customerName, customerAddress, propertyDescription: itemLabel, plotSize,
          considerationAmount: Number(fullPrice),
          documentNumber: invoice.invoice_number, contractCode, deedDate: payDate,
        });
        await attachDeed({ docKind: 'invoice', docId: invoice.invoice_id, deedPdf });
        docsSent.push('Deed of Conveyance');
      } catch (e) {
        emailErrors.push(`Contract generation: ${e.message}`);
      }

      // Send the invoice to the customer (emails their copy, CC'd to the
      // realtor(s) — the logged-in staff member plus any manually-entered
      // realtor emails) and explicitly mark it as sent — this is what
      // moves it out of draft status in Zoho Books. Done independently so
      // a failed email doesn't leave the invoice stuck in Draft.
      try {
        await zoho.sendInvoiceEmail(invoice.invoice_id, { email: customerEmail, ccEmail: ccList, invoiceNumber: invoice.invoice_number, sendAttachment: true, contractCode });
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
      const notesText = `Installment plan. Initial deposit NGN ${Number(amtPaid).toLocaleString()} on ${payDate} via ${payMode}${notes ? ' — ' + notes : ''}`;
      const so = await zoho.createSalesOrder({
        customerId, date: payDate, itemId: item?.item_id, lineItemName: itemLabel, rate: Number(fullPrice), notes: notesText, salesperson,
      });
      const verified = await zoho.verifySalesOrderExists(so.salesorder_id);
      if (!verified) throw new Error('Sales order was created but could not be verified. Check Zoho Books directly.');
      docType = 'sales_order'; docId = so.salesorder_id; docNumber = so.salesorder_number;

      // The Contract of Sale goes out with every installment sale right
      // from the start — same as outright. The Deed of Conveyance is the
      // one exception: it only rides along once this property is
      // actually fully paid for — either the very first deposit already
      // covers the full price, or the "final payment" toggle was ticked.
      // Otherwise it waits for the balance to actually reach zero (see
      // the top-up branch below).
      isFinalPayment = Boolean(finalPayment) || Number(amtPaid) >= Number(fullPrice);
      docsSent.push('Sales Order');
      try {
        contractCode = await generateContractCode(payDate);
        const contractPdf = await buildContractPdf({
          customerName, customerAddress, propertyDescription: itemLabel, plotSize,
          fullPrice: Number(fullPrice), amountPaid: Number(amtPaid),
          contractDate: payDate, documentNumber: so.salesorder_number, contractCode,
          deedAttached: isFinalPayment,
        });
        await attachContract({ docKind: 'salesorder', docId: so.salesorder_id, contractPdf });
        docsSent.push('Contract of Sale');

        if (isFinalPayment) {
          const deedPdf = await buildDeedOfAssignmentPdf({
            customerName, customerAddress, propertyDescription: itemLabel, plotSize,
            considerationAmount: Number(fullPrice),
            documentNumber: so.salesorder_number, contractCode, deedDate: payDate,
          });
          await attachDeed({ docKind: 'salesorder', docId: so.salesorder_id, deedPdf });
          docsSent.push('Deed of Conveyance');
        }
      } catch (e) {
        emailErrors.push(`Contract generation: ${e.message}`);
      }

      // Send the sales order to the customer (emails their copy, CC'd to
      // the realtor(s) — the logged-in staff member plus any
      // manually-entered realtor emails) and explicitly mark it as Open —
      // sales orders use Draft/Open/Closed/Void in Zoho Books (not
      // "sent"). sendAttachment is always true here since the Contract of
      // Sale is always attached above. Done independently so a failed
      // email doesn't leave the order stuck in Draft.
      try {
        await zoho.sendSalesOrderEmail(so.salesorder_id, { email: customerEmail, ccEmail: ccList, salesorderNumber: so.salesorder_number, sendAttachment: true, contractCode });
        emailSent = true;
      } catch (e) {
        emailErrors.push(`Sales order email: ${e.message}`);
      }
      if (isFinalPayment) {
        try {
          await zoho.markSalesOrderClosed(so.salesorder_id);
        } catch (e) {
          emailErrors.push(`Sales order status update: ${e.message}`);
        }
      } else {
        try {
          await zoho.markSalesOrderOpen(so.salesorder_id);
        } catch (e) {
          emailErrors.push(`Sales order status update: ${e.message}`);
        }
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
        newPayment: { date: payDate, amount: Number(amtPaid), mode: payMode },
        contractTotal: Number(salesOrder.total),
        soNumber: salesOrder.salesorder_number,
      });
      paymentHistoryHtml = html;

      // Final payment on a top-up: either the running balance has hit
      // zero on its own, or the "final payment" toggle was ticked to force
      // it (e.g. a cash settlement of an odd remaining amount). Either way,
      // this is the moment the full document bundle — a freshly-generated
      // Contract of Sale reflecting full settlement, plus the Deed of
      // Assignment — goes out on the original sales order, and the order
      // is closed out. A legacy entry NEVER triggers this, even if it
      // happens to bring the balance to zero — it's a portal-only record
      // of something that already happened, not a live payment event.
      isFinalPayment = !isLegacyEntry && (Boolean(finalPayment) || soRemainingBalance <= 0);
      if (isFinalPayment) {
        try {
          const originalTx = priorPayments.find((t) => t.docType === 'sales_order');
          const finalContractCode = originalTx?.contractCode || await generateContractCode(payDate);
          contractCode = finalContractCode;
          const contractPdf = await buildContractPdf({
            customerName,
            customerAddress,
            propertyDescription: salesOrder.subject || itemLabel,
            plotSize: originalTx?.plotSize || '',
            fullPrice: Number(salesOrder.total),
            amountPaid: priorPaid + Number(amtPaid),
            contractDate: payDate,
            documentNumber: salesOrder.salesorder_number,
            contractCode: finalContractCode,
            deedAttached: true,
          });
          await attachContract({ docKind: 'salesorder', docId: salesOrder.salesorder_id, contractPdf });
          docsSent.push('Sales Order (final)', 'Contract of Sale');

          const deedPdf = await buildDeedOfAssignmentPdf({
            customerName,
            customerAddress,
            propertyDescription: originalTx?.propDesc || salesOrder.subject || itemLabel,
            plotSize: originalTx?.plotSize || '',
            considerationAmount: Number(salesOrder.total),
            documentNumber: salesOrder.salesorder_number,
            contractCode: finalContractCode,
            deedDate: payDate,
          });
          await attachDeed({ docKind: 'salesorder', docId: salesOrder.salesorder_id, deedPdf });
          docsSent.push('Deed of Conveyance');

          await zoho.sendSalesOrderEmail(salesOrder.salesorder_id, {
            email: customerEmail,
            ccEmail: ccList,
            salesorderNumber: salesOrder.salesorder_number,
            sendAttachment: true,
            contractCode: finalContractCode,
          });

          try {
            await zoho.markSalesOrderClosed(salesOrder.salesorder_id);
          } catch (e) {
            emailErrors.push(`Sales order status update: ${e.message}`);
          }
        } catch (e) {
          emailErrors.push(`Final payment document bundle: ${e.message}`);
        }
      }
    }

    // Every transaction gets a payment receipt emailed to the customer —
    // except a legacy entry, which must never send any email at all.
    // Top-ups additionally get the full payment-history table embedded
    // in the email body.
    if (!isLegacyEntry) {
      try {
        await zoho.sendPaymentReceiptEmail(payment.payment_id, {
          email: customerEmail,
          ccEmail: ccList,
          paymentNumber: payment.payment_number,
          extraBodyHtml: paymentHistoryHtml,
        });
        emailSent = true;
      } catch (e) {
        emailErrors.push(`Receipt email: ${e.message}`);
      }
    }

    // Step 4: append to transaction log in KV
    const entry = {
      id: `tx_${Date.now()}`,
      // A legacy entry's timestamp IS the historical payment date the
      // realtor entered — that's what makes it sort correctly into the
      // payment-history table and show the right date everywhere else.
      // Every other transaction type keeps the actual processing time.
      timestamp: isLegacyEntry ? new Date(payDate).toISOString() : new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      isLegacy: isLegacyEntry,
      realtor: session.displayName,
      realtorUsername: session.username,
      realtorEmail: realtorEmailForLog,
      custName: customerName,
      custId: customerId,
      custEmail: customerEmail || '',
      custCreated: customerCreated,
      txType,
      propDesc: itemLabel,
      plotSize: plotSize || '',
      amtPaid: Number(amtPaid),
      fullPrice: Number(fullPrice || 0),
      payMode: isLegacyEntry ? 'legacy' : payMode,
      bankAccountName: isLegacyEntry ? '' : (bankAccount?.account_name || ''),
      docType,
      docId,
      docNumber,
      contractCode,
      paymentId: payment ? payment.payment_id : null,
      soNumber: txType === 'topup' ? salesOrder.salesorder_number : null,
      finalPayment: isFinalPayment,
      docsSent,
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
