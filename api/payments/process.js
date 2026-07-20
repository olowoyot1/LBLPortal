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
      bankAccount, salesperson, notes, realtorEmails, finalPayment,
    } = req.body || {};

    if (!txType || !amtPaid || !payDate) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

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

    // Step 2: create payment receipt
    const itemLabel = (item?.name || propDesc || salesOrder?.subject || 'property');
    const description = `Payment for ${itemLabel}${notes ? ' — ' + notes : ''}`;
    const payment = await zoho.createCustomerPayment({
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

    // Step 3: create matching document
    let docType = 'receipt_only';
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
    // top-ups the sales order itself) goes out with this payment.
    let isFinalPayment = false;
    let docsSent = ['Payment Receipt'];

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
          documentNumber: invoice.invoice_number, contractCode,
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

      // Generate and attach the customized Contract of Sale — every sale
      // gets this. The Deed of Conveyance only goes out if this
      // installment sale happens to be fully settled from day one — the
      // very first deposit already covers the full price, or the "final
      // payment" toggle was ticked. Otherwise the deed waits for the
      // balance to actually reach zero (see the top-up branch below).
      isFinalPayment = Boolean(finalPayment) || Number(amtPaid) >= Number(fullPrice);
      try {
        contractCode = await generateContractCode(payDate);
        const contractPdf = await buildContractPdf({
          customerName, customerAddress, propertyDescription: itemLabel, plotSize,
          fullPrice: Number(fullPrice), amountPaid: Number(amtPaid),
          contractDate: payDate, documentNumber: so.salesorder_number, contractCode,
          deedAttached: isFinalPayment,
        });
        await attachContract({ docKind: 'salesorder', docId: so.salesorder_id, contractPdf });
        docsSent.push('Sales Order', 'Contract of Sale');

        if (isFinalPayment) {
          const deedPdf = await buildDeedOfAssignmentPdf({
            customerName, customerAddress, propertyDescription: itemLabel, plotSize,
            considerationAmount: Number(fullPrice),
            documentNumber: so.salesorder_number, contractCode,
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
      // "sent"). Done independently so a failed email doesn't leave the
      // order stuck in Draft.
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
      // is closed out.
      isFinalPayment = Boolean(finalPayment) || soRemainingBalance <= 0;
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

    // Every transaction — receipt-only top-ups included — emails the
    // customer their payment receipt. Top-ups additionally get the full
    // payment-history table embedded in the email body.
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

    // Step 4: append to transaction log in KV
    const entry = {
      id: `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
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
      payMode,
      bankAccountName: bankAccount?.account_name || '',
      docType,
      docId,
      docNumber,
      contractCode,
      paymentId: payment.payment_id,
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
