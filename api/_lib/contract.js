// api/_lib/contract.js
// Generates a customized "Contract of Sale" PDF for a customer, populated
// with their name/address, the property description, plot size, and the
// agreed price. Mirrors Landblaze's standard contract template (see
// company docs) but fills in the variable fields per-transaction instead
// of being a static form.
import PDFKit from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_NAME = 'LANDBLAZE LIMITED';
const VENDOR_ADDRESS = 'Wasiu Adesina Avenue, Opako, Adigbe, Abeokuta, Ogun State';

// The vendor's signature is stamped automatically on every contract from a
// committed image file rather than left blank for manual signing. Missing
// gracefully: if the file isn't present (e.g. not yet added to the repo),
// the contract still generates correctly with a blank line, just like
// before — this is a visual enhancement, not a hard dependency.
const SIGNATURE_PATH = path.join(__dirname, 'assets', 'vendor-signature.png');
function loadVendorSignature() {
  try {
    return fs.readFileSync(SIGNATURE_PATH);
  } catch (e) {
    return null;
  }
}

function ngn(n) {
  return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

const PURCHASER_COVENANTS = [
  'To promptly refund/pay back any bank charges accruing from the Purchaser\u2019s dishonoured cheque(s) issued to the Vendor, if any.',
  'Where applicable, to accept and deem as proper service any document served by the Vendor on the Purchaser, his/her Agent/Representative or by dropping same at the last known address of the Purchaser or that of her Agent.',
  'Upon physical allocation, the Purchaser shall take possession and undertake the construction of his/her building as deem fit.',
  'The Purchaser covenants with the Vendor that she shall seek and obtain express approval of the Vendor by providing a building plan of the proposed construction to be constructed on the land to the Vendor before any construction can be commenced on the land.',
  'To build house(s) within the Estate as designated \u2013 either as a Residential home or a Commercial outfit particularly as reflected in the Subscription Form.',
  'That the Purchaser shall not build or erect any shop and/or tenement house colloquially known as \u201cface-me-I-face-you\u201d on any part of the property in the Estate.',
  'Where the Purchaser purchases the property for secondary sale purposes only (where the land is purchased with the intent to re-sell), the Purchaser shall pay only the cost of the assigned portion of land. All other fees such as Transfer Processing Fee, Survey Plan, Legal Documentation, Developmental Fee and other requisite fees shall be paid by the intending purchaser.',
  'That in the event of transfer or outright sale of the said property to an intending Purchaser and upon that new Purchaser being ready to build, such intending Purchaser shall pay to the Vendor a Transfer Processing Fee PROVIDED as follows: (i) the Purchaser must have made full payment for the land in question; (ii) the Vendor must have been informed in writing of the purchaser\u2019s intention to transfer before such transfer can be effective; (iii) the intending Purchaser shall pay a Transfer Processing Fee of 10% of the current value of the land in question to the Vendor herein before such transfer can be valid; and (iv) the Purchaser shall surrender all previous documents issued to him/her by the Vendor prior to the issuance of new Contract documents by the Vendor to the intending Purchaser.',
];

const MUTUAL_COVENANTS = [
  'The Purchaser\u2019s building plans must be duly approved by the Construction and Design Department of the Vendor and forwarded to the Bureau of Town Planning for government approval.',
  'After selection of the particular housing design of the Purchaser\u2019s choice from the pool of Architectural \u201c3D\u201d plans or any of the Purchaser\u2019s options, a bill of quantity shall be agreed to by the parties herein before a building contract agreement is drawn (where applicable).',
];

/**
 * Build the Contract of Sale PDF as a Buffer.
 *
 * @param {Object} params
 * @param {string} params.customerName
 * @param {string} params.customerAddress
 * @param {string} params.propertyDescription  e.g. item name / sales order subject
 * @param {string} [params.plotSize]            e.g. "3000 square meters"
 * @param {number} params.fullPrice            total agreed purchase price
 * @param {number} params.amountPaid           initial payment already made
 * @param {string} params.contractDate         ISO date string
 * @param {string} [params.documentNumber]      invoice/sales order number, shown for reference
 * @param {string} [params.contractCode]        app-generated reference code, e.g. LBL-2026-0001
 * @param {boolean} [params.deedAttached]        true when the Deed of Assignment template is riding along as a separate attachment on this same email
 * @returns {Promise<Buffer>}
 */
export function buildContractPdf({
  customerName,
  customerAddress,
  propertyDescription,
  plotSize,
  fullPrice,
  amountPaid,
  contractDate,
  documentNumber,
  contractCode,
  deedAttached,
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
    const size = (plotSize || '').trim();
    const total = Number(fullPrice || 0);
    const paid = Number(amountPaid || 0);
    const dateStr = fmtDate(contractDate);
    const signatureImg = loadVendorSignature();

    const center = (text, opts = {}) => doc.text(text, { align: 'center', ...opts });
    const para = (text, opts = {}) => doc.text(text, { align: 'justify', ...opts });
    const spacer = (h = 10) => doc.moveDown(h / doc.currentLineHeight());
    const ensureSpace = (needed) => { if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage(); };

    // Property description with size folded in, matching the standard
    // template's phrasing (e.g. "MEASURING APPROXIMATELY 3000 SQUARE
    // METERS, SITUATED AT ..."). Falls back gracefully if size is blank.
    const propDescWithSize = size
      ? `${propDesc}, MEASURING APPROXIMATELY ${size.toUpperCase()}`
      : propDesc;

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
      `IN RESPECT OF ALL THAT PARCEL OF LAND/PROPERTY, TOGETHER WITH ALL ITS APPURTENANCES, KNOWN AS ${propDescWithSize.toUpperCase()}.`,
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
      `${VENDOR_NAME}, of ${VENDOR_ADDRESS}. (hereinafter referred to as \u201cthe Vendor,\u201d which expression shall, unless inconsistent with the context or meaning, include its heirs, administrators, executors, beneficiaries, legal/personal representatives, and successors-in-title) of the ONE PART,`,
      { width: PAGE_WIDTH }
    );
    spacer(10);
    para(
      `${custName}${custAddr ? ' of ' + custAddr : ''} (hereinafter referred to as \u201cthe Purchaser,\u201d which expression shall, unless inconsistent with the context or meaning, include his/her heirs, administrators, executors, beneficiaries, legal/personal representatives, and successors in title), of the OTHER PART.`,
      { width: PAGE_WIDTH }
    );
    spacer(16);

    // 1.0 Property Description
    doc.font('Helvetica-Bold').fontSize(11).text('1.0  PROPERTY DESCRIPTION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para(
      size
        ? `The Vendor is the rightful owner of a parcel of land measuring approximately ${size}, described as ${propDesc}, which the Purchaser has agreed to purchase on the terms set out in this Contract.`
        : `The Vendor is the rightful owner of the property described as ${propDesc}, which the Purchaser has agreed to purchase on the terms set out in this Contract.`,
      { width: PAGE_WIDTH }
    );
    spacer(14);

    // 2.0 Agreed Purchase Price
    doc.font('Helvetica-Bold').fontSize(11).text('2.0  AGREED PURCHASE PRICE', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para(
      documentNumber
        ? `In consideration of the sum of ${ngn(total)} only, the Purchaser agrees to purchase the aforementioned property from the Vendor (Reference: ${documentNumber}). The Purchaser has made an initial payment of ${ngn(paid)} to the Vendor, which the Vendor hereby acknowledges and confirms receipt of.`
        : `In consideration of the sum of ${ngn(total)} only, the Purchaser agrees to purchase the aforementioned property from the Vendor. The Purchaser has made an initial payment of ${ngn(paid)} to the Vendor, which the Vendor hereby acknowledges and confirms receipt of.`,
      { width: PAGE_WIDTH }
    );
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
    ].forEach((t) => { doc.text(`\u2022  ${t}`, { width: PAGE_WIDTH, align: 'justify' }); spacer(4); });
    spacer(6);

    doc.font('Helvetica-Bold').fontSize(10).text('3.2  Obligations of the Purchaser', { width: PAGE_WIDTH });
    spacer(4);
    doc.font('Helvetica').fontSize(10);
    [
      'Comply with all applicable rules and regulations governing the use of the property, including obtaining necessary approvals for construction or development.',
      'Seek prior approval from the Vendor before undertaking any structural changes or developments on the land.',
      'Ensure prompt and timely payment of the agreed installment sums or lump sum payments.',
    ].forEach((t) => { doc.text(`\u2022  ${t}`, { width: PAGE_WIDTH, align: 'justify' }); spacer(4); });
    spacer(10);

    // 4.0 Title and Documentation
    ensureSpace(160);
    doc.font('Helvetica-Bold').fontSize(11).text('4.0  TITLE AND DOCUMENTATION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para('Upon full payment of the agreed purchase price, the Vendor shall provide the Purchaser with the following documents:', { width: PAGE_WIDTH });
    spacer(4);
    ['Deed of Assignment', 'Survey Plan', 'Receipt of Payment', 'Provisional Letter of Allocation (if applicable)'].forEach((t) => {
      doc.text(`\u2022  ${t}`, { width: PAGE_WIDTH });
      spacer(3);
    });
    spacer(6);
    if (deedAttached) {
      doc.font('Helvetica-Oblique').fontSize(9);
      para('A copy of the Deed of Assignment for this property is attached alongside this Contract of Sale.', { width: PAGE_WIDTH });
      doc.font('Helvetica').fontSize(10);
      spacer(6);
    }
    spacer(4);

    // 4.1 Purchaser Covenants
    ensureSpace(140);
    doc.font('Helvetica-Bold').fontSize(10).text('THE PURCHASER COVENANTS AS FOLLOWS:', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    PURCHASER_COVENANTS.forEach((t) => {
      ensureSpace(60);
      para(t, { width: PAGE_WIDTH });
      spacer(8);
    });
    spacer(4);

    // 4.2 Mutual Covenants
    ensureSpace(140);
    doc.font('Helvetica-Bold').fontSize(10).text('THE PARTIES HEREBY COVENANT AS FOLLOWS:', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    MUTUAL_COVENANTS.forEach((t) => {
      ensureSpace(60);
      para(t, { width: PAGE_WIDTH });
      spacer(8);
    });
    spacer(10);

    // 5.0 Dispute Resolution
    ensureSpace(140);
    doc.font('Helvetica-Bold').fontSize(11).text('5.0  DISPUTE RESOLUTION', { width: PAGE_WIDTH });
    spacer(6);
    doc.font('Helvetica').fontSize(10);
    para(
      'Any disputes arising from or in connection with this contract shall be resolved amicably between the parties. In the event that an amicable resolution cannot be reached, the matter shall be referred to arbitration in accordance with the provisions of the Arbitration and Conciliation Act of Nigeria. The decision of the arbitrator(s) shall be final and binding on both parties.',
      { width: PAGE_WIDTH }
    );
    spacer(24);

    // Signature block — vendor side is auto-stamped with the saved
    // signature image; purchaser side stays a blank line for physical or
    // future e-signature.
    ensureSpace(190);
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('IN WITNESS WHEREOF, the parties hereto have executed this agreement on the day and year first above written.', { width: PAGE_WIDTH });
    spacer(14);

    const colWidth = PAGE_WIDTH / 2 - 10;
    const sigBlockTop = doc.y;
    const sigImgHeight = 40;

    if (signatureImg) {
      try {
        doc.image(signatureImg, doc.page.margins.left, sigBlockTop, { fit: [colWidth, sigImgHeight], align: 'left' });
      } catch (e) {
        // Corrupt/unsupported image file — fall back to a blank line rather
        // than failing the whole contract generation.
        doc.font('Helvetica').fontSize(10).text('.......................................', doc.page.margins.left, sigBlockTop, { width: colWidth });
      }
    } else {
      doc.font('Helvetica').fontSize(10).text('.......................................', doc.page.margins.left, sigBlockTop, { width: colWidth });
    }
    doc.font('Helvetica').fontSize(10).text('.......................................', doc.page.margins.left + colWidth + 20, sigBlockTop, { width: colWidth });

    const labelY = sigBlockTop + sigImgHeight + 4;
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('SIGNED BY VENDOR', doc.page.margins.left, labelY, { width: colWidth });
    doc.text(VENDOR_NAME, doc.page.margins.left, doc.y, { width: colWidth });
    let leftBottomY = doc.y;
    doc.text('SIGNED BY PURCHASER', doc.page.margins.left + colWidth + 20, labelY, { width: colWidth });
    doc.text(custName.toUpperCase(), doc.page.margins.left + colWidth + 20, doc.y, { width: colWidth });
    doc.y = Math.max(doc.y, leftBottomY) + 20;

    // Witness block
    ensureSpace(140);
    doc.font('Helvetica-Bold').fontSize(11);
    center('WITNESS');
    spacer(10);
    doc.font('Helvetica').fontSize(10);

    const fieldWidth = PAGE_WIDTH;
    doc.text('Name: _________________________________________   Signature: ____________', doc.page.margins.left, doc.y, { width: fieldWidth });
    spacer(12);
    doc.text('Address: _______________________________________________________________', doc.page.margins.left, doc.y, { width: fieldWidth });
    spacer(12);
    doc.text('Occupation: ____________________________________________________________', doc.page.margins.left, doc.y, { width: fieldWidth });
    spacer(12);
    doc.text('Telephone: _____________________________________________________________', doc.page.margins.left, doc.y, { width: fieldWidth });
    spacer(20);

    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    const footerParts = [`Generated electronically on ${fmtDate(new Date())}`];
    if (documentNumber) footerParts.push(`Ref: ${documentNumber}`);
    if (contractCode) footerParts.push(`Contract Code: ${contractCode}`);
    doc.text(footerParts.join(' \u2014 '), doc.page.margins.left, doc.y, { width: PAGE_WIDTH, align: 'center' });
    doc.fillColor('#000000');

    doc.end();
  });
}
