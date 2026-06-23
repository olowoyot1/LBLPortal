// api/_lib/contract.js
// Generates a customized "Contract of Sale" PDF for a customer, populated
// with their name/address, the property description, and the agreed price.
// Mirrors Landblaze's standard contract template (see company docs) but
// fills in the variable fields per-transaction instead of being a static form.
import PDFKit from 'pdfkit';

const VENDOR_NAME = 'LANDBLAZE LIMITED';
const VENDOR_ADDRESS = 'Wasiu Adesina Avenue, Opako, Adigbe, Abeokuta, Ogun State';

function ngn(n) {
  return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

/**
 * Build the Contract of Sale PDF as a Buffer.
 *
 * @param {Object} params
 * @param {string} params.customerName
 * @param {string} params.customerAddress
 * @param {string} params.propertyDescription  e.g. item name / sales order subject
 * @param {number} params.fullPrice            total agreed purchase price
 * @param {number} params.amountPaid           initial payment already made
 * @param {string} params.contractDate         ISO date string
 * @param {string} [params.documentNumber]      invoice/sales order number, shown for reference
 * @returns {Promise<Buffer>}
 */
export function buildContractPdf({
  customerName,
  customerAddress,
  propertyDescription,
  fullPrice,
  amountPaid,
  contractDate,
  documentNumber,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: 'A4', margins: { top: 56, bottom: 56, left: 64, right: 64 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_WIDTH = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const custName = (customerName || 'the Purchaser').trim();
    const custAddr = (customerAddress || '').trim();
    const propDesc = (propertyDescription || 'the property').trim();
    const total = Number(fullPrice || 0);
    const paid = Number(amountPaid || 0);
    const dateStr = fmtDate(contractDate);

    const center = (text, opts = {}) => doc.text(text, { align: 'center', ...opts });
    const para = (text, opts = {}) => doc.text(text, { align: 'justify', ...opts });
    const spacer = (h = 10) => doc.moveDown(h / doc.currentLineHeight());

    // ── Title block ──
    doc.font('Helvetica-Bold').fontSize(16);
    center('CONTRACT OF SALE');
    spacer(16);

    doc.font('Helvetica').fontSize(11);
    center('Between');
    spacer(6);
    doc.font('Helvetica-Bold').fontSize(12);
    center(VENDOR_NAME);
    doc.font('Helvetica').fontSize(10);
    center('Vendor');
    spacer(8);
    doc.font('Helvetica').fontSize(11);
    center('And');
    spacer(6);
    doc.font('Helvetica-Bold').fontSize(12);
    center(custName.toUpperCase());
    doc.font('Helvetica').fontSize(10);
    center('Purchaser');
    spacer(16);

    doc.font('Helvetica-Bold').fontSize(10);
    para(
      `IN RESPECT OF ALL THAT PARCEL OF LAND/PROPERTY, TOGETHER WITH ALL ITS APPURTENANCES, KNOWN AS ${propDesc.toUpperCase()}.`,
      { width: PAGE_WIDTH }
    );
    spacer(14);

    doc.font('Helvetica').fontSize(10);
    para(`DATED THIS ${dateStr}.`, { width: PAGE_WIDTH });
    spacer(18);

    para(
      `THIS CONTRACT OF SALE is made this ${dateStr},`,
      { width: PAGE_WIDTH }
    );
    spacer(10);

    // BETWEEN
    doc.font('Helvetica-Bold').fontSize(10).text('BETWEEN', { continued: false });
    spacer(8);
    doc.font('Helvetica').fontSize(10);
    para(
      `${VENDOR_NAME}, of ${VENDOR_ADDRESS}. (hereinafter referred to as “the Vendor,” which expression shall, unless inconsistent with the context or meaning, include its heirs, administrators, executors, beneficiaries, legal/personal representatives, and successors-in-title) of the ONE PART,`,
      { width: PAGE_WIDTH }
    );
    spacer(10);
    para(
      `${custName}${custAddr ? ' of ' + custAddr : ''} (hereinafter referred to as “the Purchaser,” which expression shall, unless inconsistent with the context or meaning, include his/her heirs, administrators, executors, beneficiaries, legal/personal representatives, and successors in title), of the OTHER PART.`,
      { width: PAGE_WIDTH }
    );
    spacer(16);

    // 1.0 Property Description
    doc.font('Helvetica-Bold').fontSize(11).text('1.0  PROPERTY DESCRIPTION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para(
      `The Vendor is the rightful owner of the property described as ${propDesc}, which the Purchaser has agreed to purchase on the terms set out in this Contract.`,
      { width: PAGE_WIDTH }
    );
    spacer(14);

    // 2.0 Agreed Purchase Price
    doc.font('Helvetica-Bold').fontSize(11).text('2.0  AGREED PURCHASE PRICE', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    if (documentNumber) {
      para(
        `In consideration of the sum of ${ngn(total)} only, the Purchaser agrees to purchase the aforementioned property from the Vendor (Reference: ${documentNumber}). The Purchaser has made an initial payment of ${ngn(paid)} to the Vendor, which the Vendor hereby acknowledges and confirms receipt of.`,
        { width: PAGE_WIDTH }
      );
    } else {
      para(
        `In consideration of the sum of ${ngn(total)} only, the Purchaser agrees to purchase the aforementioned property from the Vendor. The Purchaser has made an initial payment of ${ngn(paid)} to the Vendor, which the Vendor hereby acknowledges and confirms receipt of.`,
        { width: PAGE_WIDTH }
      );
    }
    spacer(14);

    // 3.0 Obligations
    doc.font('Helvetica-Bold').fontSize(11).text('3.0  OBLIGATIONS OF THE PARTIES', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica-Bold').fontSize(10).text('3.1  Obligations of the Vendor', { width: PAGE_WIDTH });
    spacer(4);
    doc.font('Helvetica').fontSize(10);
    [
      'Deliver all relevant documents pertaining to the property, including a Deed of Assignment and a Survey Plan, upon full settlement of the purchase price.',
      'Indemnify the Purchaser against any claims or disputes arising in relation to the title or ownership of the property.',
      'Accept and receive payments from the Purchaser, whether made as monthly installments or lump sum payments, provided such payments are not defaulted under any conditions or grounds.',
    ].forEach((t) => { doc.text(`•  ${t}`, { width: PAGE_WIDTH, align: 'justify' }); spacer(4); });
    spacer(6);

    doc.font('Helvetica-Bold').fontSize(10).text('3.2  Obligations of the Purchaser', { width: PAGE_WIDTH });
    spacer(4);
    doc.font('Helvetica').fontSize(10);
    [
      'Comply with all applicable rules and regulations governing the use of the property, including obtaining necessary approvals for construction or development.',
      'Seek prior approval from the Vendor before undertaking any structural changes or developments on the land.',
      'Ensure prompt and timely payment of the agreed installment sums or lump sum payments.',
    ].forEach((t) => { doc.text(`•  ${t}`, { width: PAGE_WIDTH, align: 'justify' }); spacer(4); });
    spacer(10);

    // 4.0 Title and Documentation
    if (doc.y > doc.page.height - doc.page.margins.bottom - 160) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text('4.0  TITLE AND DOCUMENTATION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para('Upon full payment of the agreed purchase price, the Vendor shall provide the Purchaser with the following documents:', { width: PAGE_WIDTH });
    spacer(4);
    ['Deed of Assignment', 'Survey Plan', 'Receipt of Payment', 'Provisional Letter of Allocation (if applicable)'].forEach((t) => {
      doc.text(`•  ${t}`, { width: PAGE_WIDTH });
      spacer(3);
    });
    spacer(10);

    // 5.0 Dispute Resolution
    if (doc.y > doc.page.height - doc.page.margins.bottom - 120) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text('5.0  DISPUTE RESOLUTION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para(
      'Any disputes arising from or in connection with this contract shall be resolved amicably between the parties. In the event that an amicable resolution cannot be reached, the matter shall be referred to arbitration in accordance with the provisions of the Arbitration and Conciliation Act of Nigeria. The decision of the arbitrator(s) shall be final and binding on both parties.',
      { width: PAGE_WIDTH }
    );
    spacer(24);

    // Signature block
    if (doc.y > doc.page.height - doc.page.margins.bottom - 140) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('IN WITNESS WHEREOF, the parties hereto have executed this agreement on the day and year first above written.', { width: PAGE_WIDTH });
    spacer(30);

    const colWidth = PAGE_WIDTH / 2 - 10;
    const sigY = doc.y;
    doc.font('Helvetica').fontSize(10);
    doc.text('.......................................', doc.page.margins.left, sigY, { width: colWidth });
    doc.text('.......................................', doc.page.margins.left + colWidth + 20, sigY, { width: colWidth });
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('SIGNED BY VENDOR', doc.page.margins.left, doc.y + 4, { width: colWidth });
    doc.text(VENDOR_NAME, doc.page.margins.left, doc.y, { width: colWidth });
    let leftBottomY = doc.y;
    doc.text('SIGNED BY PURCHASER', doc.page.margins.left + colWidth + 20, sigY + 18, { width: colWidth });
    doc.text(custName.toUpperCase(), doc.page.margins.left + colWidth + 20, doc.y, { width: colWidth });
    doc.y = Math.max(doc.y, leftBottomY) + 20;

    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(`Generated electronically on ${fmtDate(new Date())}${documentNumber ? ' — Ref: ' + documentNumber : ''}`, doc.page.margins.left, doc.y, { width: PAGE_WIDTH, align: 'center' });
    doc.fillColor('#000000');

    doc.end();
  });
}
