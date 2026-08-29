// Generate a customer statement from Zoho Books Sales Orders + Sales Receipts.
// We deliberately do not use Zoho's native customer statement because the
// portal's business model treats Sales Orders as the contract/value side and
// Sales Receipts as the payment/income side.
import PDFDocument from 'pdfkit';
import { handleCors } from './_lib/cors.js';
import { requireAuth } from './_lib/auth.js';
import { getTransactions } from './_lib/db.js';
import { getContact, listCustomerSalesOrders, listCustomerSalesReceipts } from './_lib/zoho.js';

const money = (n) => `NGN ${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const safeDate = (d) => {
  if (!d) return '';
  const x = new Date(`${d}T00:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-NG');
};
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

function buildPdf({ customer, orders, receipts, transactions }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Customer Statement - ${customer.customer_name}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const txByReceipt = new Map();
    for (const t of transactions) {
      if (t.salesReceiptId) txByReceipt.set(String(t.salesReceiptId), t);
      else if (t.docType === 'sales_receipt' && t.docId) txByReceipt.set(String(t.docId), t);
    }

    const orderByNumber = new Map(orders.map((o) => [o.salesorder_number, o]));
    const orderById = new Map(orders.map((o) => [String(o.salesorder_id), o]));
    const orderItemIds = new Map();
    const orderItemNames = new Map();
    for (const o of orders) {
      for (const li of o.line_items || []) {
        if (li.item_id) {
          const key = String(li.item_id);
          orderItemIds.set(key, [...(orderItemIds.get(key) || []), o]);
        }
        if (li.name) {
          const key = li.name.trim().toLowerCase();
          orderItemNames.set(key, [...(orderItemNames.get(key) || []), o]);
        }
      }
    }

    const rows = [];
    let totalReceipts = 0;
    let receiptsAppliedToOrders = 0;
    let totalOrderValue = orders.reduce((s, o) => s + Number(o.total || 0), 0);

    for (const o of orders) {
      rows.push({ date: o.date, type: 'Sales Order', ref: o.salesorder_number, description: o.subject || o.line_items?.map((x) => x.name).filter(Boolean).join(', ') || 'Property / contract', debit: Number(o.total || 0), credit: 0 });
    }

    for (const r of receipts) {
      const amount = Number(r.total || 0);
      totalReceipts += amount;
      const local = txByReceipt.get(String(r.sales_receipt_id));
      let linkedOrder = local?.soNumber ? orderByNumber.get(local.soNumber) : null;
      if (!linkedOrder && local?.docType === 'sales_order' && local?.docId) linkedOrder = orderById.get(String(local.docId));
      if (!linkedOrder) {
        const li = (r.line_items || []).find((x) => x.item_id && orderItemIds.has(String(x.item_id)) && orderItemIds.get(String(x.item_id)).length === 1);
        linkedOrder = li ? orderItemIds.get(String(li.item_id))[0] : null;
      }
      if (!linkedOrder) {
        const li = (r.line_items || []).find((x) => x.name && orderItemNames.has(x.name.trim().toLowerCase()) && orderItemNames.get(x.name.trim().toLowerCase()).length === 1);
        linkedOrder = li ? orderItemNames.get(li.name.trim().toLowerCase())[0] : null;
      }
      if (linkedOrder) receiptsAppliedToOrders += amount;
      rows.push({
        date: r.date,
        type: 'Sales Receipt',
        ref: r.receipt_number,
        description: r.line_items?.map((x) => x.name).filter(Boolean).join(', ') || (linkedOrder?.subject || 'Payment received'),
        debit: 0,
        credit: amount,
        payment: `${r.payment_mode_name || ''}${r.deposit_to_account_name ? ` · ${r.deposit_to_account_name}` : ''}`.replace(/^ · | · $/g, ''),
        linkedOrder: linkedOrder?.salesorder_number || local?.soNumber || '',
      });
    }

    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.type === 'Sales Order' ? -1 : 1));
    let runningContractBalance = 0;

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('CUSTOMER STATEMENT');
    doc.moveDown(0.35);
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text('Landblaze Payment Portal · Statement based on Sales Orders and Sales Receipts');
    doc.fillColor('#111111');
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text(customer.customer_name || 'Customer');
    doc.fontSize(9).font('Helvetica').fillColor('#555555')
      .text(`Customer ID: ${customer.customer_id || '—'}`)
      .text(`Email: ${customer.email || '—'}`)
      .text(`Generated: ${new Date().toLocaleString('en-NG')}`);
    doc.fillColor('#111111');
    doc.moveDown(1);

    const boxY = doc.y;
    doc.roundedRect(42, boxY, 511, 66, 6).stroke('#dddddd');
    doc.fontSize(8).fillColor('#666666').text('SALES ORDER VALUE', 56, boxY + 12);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111111').text(money(totalOrderValue), 56, boxY + 27);
    doc.fontSize(8).font('Helvetica').fillColor('#666666').text('SALES RECEIPTS', 245, boxY + 12);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111111').text(money(totalReceipts), 245, boxY + 27);
    doc.fontSize(8).font('Helvetica').fillColor('#666666').text('NET OUTSTANDING', 420, boxY + 12);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111111').text(money(Math.max(0, totalOrderValue - receiptsAppliedToOrders)), 420, boxY + 27);
    doc.y = boxY + 82;

    // Explanation
    doc.fontSize(8.5).font('Helvetica').fillColor('#555555')
      .text('Statement logic: Sales Orders represent the contracted/property value. Sales Receipts represent amounts actually received and posted to income. Only receipts linked to a Sales Order are applied against its outstanding contract balance; outright/unallocated receipts remain visible but do not reduce a separate Sales Order balance.');
    doc.fillColor('#111111').moveDown(0.8);

    // Statement ledger: show the contract balance after every transaction.
    // Sales Orders increase the contract balance; only receipts linked to a
    // Sales Order reduce it. Outright/unallocated receipts remain visible but
    // do not reduce a contract balance.
    const x = [42, 100, 175, 335, 405, 480];
    const widths = [58, 75, 160, 70, 75, 73];
    const header = () => {
      const y = doc.y;
      doc.rect(42, y, 511, 22).fill('#eeeeee');
      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(7.5);
      ['Date', 'Type', 'Reference / Description', 'Debit', 'Credit', 'Balance Left'].forEach((h, i) => doc.text(h, x[i] + 4, y + 7, { width: widths[i] - 8 }));
      doc.fillColor('#111111').font('Helvetica');
      doc.y = y + 22;
    };
    header();

    for (const r of rows) {
      const desc = r.description || '';
      const link = r.type === 'Sales Receipt'
        ? [r.payment, r.linkedOrder ? `SO: ${r.linkedOrder}` : 'Unallocated / Outright'].filter(Boolean).join(' · ')
        : '';
      const detail = `${r.ref || '—'}${desc ? `\n${desc}` : ''}${link ? `\n${link}` : ''}`;
      const h = Math.max(30, Math.ceil(Math.max(detail.length / 46, 1)) * 10 + 10);
      if (doc.y + h > 760) { doc.addPage(); header(); }
      const y = doc.y;

      if (r.type === 'Sales Order') {
        runningContractBalance += Number(r.debit || 0);
      } else if (r.type === 'Sales Receipt' && r.linkedOrder) {
        runningContractBalance = Math.max(0, runningContractBalance - Number(r.credit || 0));
      }

      doc.fontSize(7.5).fillColor('#222222');
      doc.text(safeDate(r.date), x[0] + 4, y + 7, { width: widths[0] - 8 });
      doc.text(r.type, x[1] + 4, y + 7, { width: widths[1] - 8 });
      doc.text(`${r.ref || '—'}${desc ? `\n${desc}` : ''}`, x[2] + 4, y + 5, { width: widths[2] - 8 });
      doc.text(r.debit ? money(r.debit) : '—', x[3] + 4, y + 7, { width: widths[3] - 8, align: 'right' });
      doc.text(r.credit ? money(r.credit) : '—', x[4] + 4, y + 7, { width: widths[4] - 8, align: 'right' });
      doc.font('Helvetica-Bold').text(money(runningContractBalance), x[5] + 4, y + 7, { width: widths[5] - 8, align: 'right' });
      doc.font('Helvetica');
      if (link) doc.fontSize(6.8).fillColor('#666666').text(link, x[2] + 4, y + h - 11, { width: widths[2] - 8 });
      doc.fillColor('#222222');
      doc.moveTo(42, y + h).lineTo(553, y + h).stroke('#eeeeee');
      doc.y = y + h;
    }

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(10).text(`Contracted Sales Order Value: ${money(totalOrderValue)}`);
    doc.text(`Total Sales Receipts: ${money(totalReceipts)}`);
    doc.text(`Outstanding Sales Order Value: ${money(Math.max(0, totalOrderValue - receiptsAppliedToOrders))}`);
    doc.font('Helvetica').fontSize(8).fillColor('#666666').moveDown(0.5)
      .text('This statement was generated by the Landblaze Payment Portal from live Zoho Books Sales Order and Sales Receipt records.');

    doc.end();
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const session = await requireAuth(req, res);
    if (!session) return;
    const customerId = String(req.query.customerId || '').trim();
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const [customer, orders, receipts, transactions] = await Promise.all([
      getContact(customerId),
      listCustomerSalesOrders(customerId),
      listCustomerSalesReceipts(customerId),
      getTransactions(),
    ]);

    const pdf = await buildPdf({ customer, orders, receipts, transactions: transactions.filter((t) => String(t.custId) === customerId) });
    const filename = `Landblaze-Statement-${(customer.customer_name || 'Customer').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not generate customer statement' });
  }
}
