// api/_lib/deed.js
// Generates a customized "Deed of Conveyance" (Deed of Assignment) PDF for
// a customer, populated with their name/address, the property description,
// plot size, and the full consideration paid. Mirrors Landblaze's own deed
// template (LBL legal team, RC 8102989) but fills in the variable fields
// per-transaction instead of being a static, already-completed document.
//
// IMPORTANT: a deed of conveyance transfers ownership, so — unlike the
// Contract of Sale, which goes out with every sale — this is only ever
// generated/attached once a property is FULLY PAID FOR. Callers (see
// api/payments/process.js and api/contracts/resend.js) are responsible
// for only calling buildDeedOfAssignmentPdf() when the payment in question
// is the final one.
import PDFKit from 'pdfkit';

const VENDOR_NAME = 'LANDBLAZE LIMITED';
// NOTE: this is the address used on Landblaze's own Deed of Conveyance
// template — it differs from the address used on the Contract of Sale
// (api/_lib/contract.js). Both are reproduced as given; flag to Daniel if
// one of them is out of date and should be made consistent.
const VENDOR_ADDRESS = 'C2, C6 5th Avenue, Divine Plaza, Egbeda, Lagos';
const VENDOR_RC_NUMBER = 'RC 8102989';
const PREPARED_BY = [
  'LANDBLAZE LIMITED',
  'LEGAL TEAM.',
  'C2, C6 5TH AVENUE,',
  'MOKOLA BUS STOP,',
  'DIVINE PLAZA,',
  'EGBEDA, LAGOS',
];

function ngn(n) {
  return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

// ── Number → words (Naira) ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALE = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

function threeDigitsToWords(n) {
  let str = '';
  if (n >= 100) {
    str += ONES[Math.floor(n / 100)] + ' Hundred';
    n %= 100;
    if (n) str += ' and ';
  }
  if (n >= 20) {
    str += TENS[Math.floor(n / 10)];
    if (n % 10) str += '-' + ONES[n % 10];
  } else if (n > 0) {
    str += ONES[n];
  }
  return str;
}

function numberToWords(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero';
  const chunks = [];
  let n = num;
  while (n > 0) {
    chunks.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const parts = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i] > 0) {
      parts.push(threeDigitsToWords(chunks[i]) + (SCALE[i] ? ' ' + SCALE[i] : ''));
    }
  }
  return parts.join(' ');
}

/**
 * Build the Deed of Conveyance PDF as a Buffer.
 *
 * @param {Object} params
 * @param {string} params.customerName
 * @param {string} params.customerAddress
 * @param {string} params.propertyDescription  e.g. "Blaze Green City Estate at Alabata, Abeokuta, Ogun State"
 * @param {string} [params.plotSize]            e.g. "1000 square meters"
 * @param {number} params.considerationAmount   the full/final consideration paid for the property
 * @param {string} [params.documentNumber]      invoice/sales order number, shown for reference
 * @param {string} [params.contractCode]        app-generated reference code, e.g. LBL-2026-0001
 * @returns {Promise<Buffer>}
 */
export function buildDeedOfAssignmentPdf({
  customerName,
  customerAddress,
  propertyDescription,
  plotSize,
  considerationAmount,
  documentNumber,
  contractCode,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: 'A4', margins: { top: 56, bottom: 56, left: 64, right: 64 }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_WIDTH = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const custName = (customerName || 'the Purchaser').trim();
    const custAddr = (customerAddress || '').trim();
    const propDesc = (propertyDescription || 'the property').trim();
    const size = (plotSize || '').trim();
    const amount = Number(considerationAmount || 0);

    const center = (text, opts = {}) => doc.text(text, { align: 'center', ...opts });
    const para = (text, opts = {}) => doc.text(text, { align: 'justify', ...opts });
    const spacer = (h = 10) => doc.moveDown(h / doc.currentLineHeight());
    const ensureSpace = (needed) => { if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage(); };

    const propDescWithSize = size
      ? `ALL THAT PARCEL OF LAND, TOGETHER WITH ALL ITS APPURTENANCES, MEASURING APPROXIMATELY ${size.toUpperCase()}, SITUATED AT ${propDesc.toUpperCase()}`
      : `ALL THAT PARCEL OF LAND, TOGETHER WITH ALL ITS APPURTENANCES, SITUATED AT ${propDesc.toUpperCase()}`;

    // ── Page 1: cover ──
    doc.font('Helvetica-Bold').fontSize(16);
    center('DEED OF CONVEYANCE');
    spacer(18);

    doc.font('Helvetica').fontSize(11);
    center('BY AND BETWEEN');
    spacer(10);
    doc.font('Helvetica-Bold').fontSize(13);
    center(VENDOR_NAME);
    doc.font('Helvetica').fontSize(10);
    center('of');
    center(VENDOR_ADDRESS);
    spacer(4);
    doc.font('Helvetica-Bold').fontSize(11);
    center('(VENDOR)');
    spacer(12);

    doc.font('Helvetica').fontSize(11);
    center('AND');
    spacer(10);
    doc.font('Helvetica-Bold').fontSize(13);
    center(custName.toUpperCase());
    doc.font('Helvetica').fontSize(10);
    if (custAddr) center(custAddr);
    spacer(4);
    doc.font('Helvetica-Bold').fontSize(11);
    center('(PURCHASER)');
    spacer(20);

    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.75).stroke();
    spacer(14);
    doc.font('Helvetica-Bold').fontSize(10);
    para(`IN RESPECT OF ${propDescWithSize}, NIGERIA.`, { width: PAGE_WIDTH });
    spacer(14);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.75).stroke();
    spacer(18);

    doc.font('Helvetica').fontSize(10);
    center('DATED THIS _____ DAY OF _______________, 20_____.');
    spacer(30);

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('PREPARED BY:', doc.page.width - doc.page.margins.right - 180, doc.y, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(9);
    PREPARED_BY.forEach((line) => doc.text(line, doc.page.width - doc.page.margins.right - 180, doc.y, { width: 180, align: 'right' }));

    // ── Page 2: recitals ──
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12);
    para('THIS DEED OF CONVEYANCE is made this _____ day of _______________, 20_____,', { width: PAGE_WIDTH });
    spacer(16);

    doc.font('Helvetica-Bold').fontSize(11).text('BY AND BETWEEN:', { width: PAGE_WIDTH });
    spacer(8);
    doc.font('Helvetica').fontSize(10);
    para(
      `${VENDOR_NAME}, of ${VENDOR_ADDRESS}, acting on its own behalf (hereinafter referred to as \u2018the Vendor,\u2019 which term shall, where the context so permits, include its heirs, successors-in-title, executors, and administrators), of the FIRST PART;`,
      { width: PAGE_WIDTH }
    );
    spacer(10);
    doc.font('Helvetica-Bold').fontSize(11).text('AND', { width: PAGE_WIDTH });
    spacer(8);
    doc.font('Helvetica').fontSize(10);
    para(
      `${custName.toUpperCase()}${custAddr ? ' OF ' + custAddr.toUpperCase() : ''} (hereinafter referred to as \u2018the Purchaser,\u2019 which term shall, where the context so permits, include her heirs, executors, administrators, and assigns), of the SECOND PART.`,
      { width: PAGE_WIDTH }
    );
    spacer(20);

    doc.font('Helvetica-Bold').fontSize(11).text('1.0  WHEREAS:', { width: PAGE_WIDTH });
    spacer(8);
    doc.font('Helvetica').fontSize(10);
    [
      `The vendor, ${VENDOR_NAME}, a company duly registered under the laws of the Federal Republic of Nigeria with registration number ${VENDOR_RC_NUMBER}, is the lawful owner and person in possession of the parcel of land described herein, having exercised uninterrupted and exclusive acts of ownership over the said property.`,
      'The Vendor has agreed to sell, assign, and convey the said parcel of land to the Purchaser under the terms and conditions set forth in this Deed.',
      'The Purchaser, having inspected and accepted the terms of sale, has agreed to purchase the said parcel of land from the Vendor for the consideration specified herein, subject to the covenants and provisions contained in this Deed.',
    ].forEach((t, i) => {
      ensureSpace(70);
      para(`${i + 1}. ${t}`, { width: PAGE_WIDTH });
      spacer(10);
    });

    // ── Page 3: operative clause ──
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text('2.0  NOW THIS DEED WITNESSES AS FOLLOWS:', { width: PAGE_WIDTH });
    spacer(10);
    doc.font('Helvetica').fontSize(10);
    para(
      `1. In consideration of the sum of ${ngn(amount)} (${numberToWords(amount)} Naira), paid by the purchaser to the vendor (the receipt of which is hereby acknowledged), the vendor, being the beneficial owner, hereby grants, conveys, assigns, and transfers unto the purchaser:`,
      { width: PAGE_WIDTH }
    );
    spacer(10);
    doc.font('Helvetica-Bold').fontSize(10);
    para(
      `Full ownership and absolute possession, free from all known encumbrances, of all that parcel of land situated at ${propDesc}${size ? ', measuring approximately ' + size : ''}.`,
      { width: PAGE_WIDTH }
    );
    spacer(14);
    doc.font('Helvetica').fontSize(10);
    para(
      '2. TO HAVE AND TO HOLD the said parcel of land unto the Purchaser, her heirs, successors, executors, administrators, and assigns, in fee simple absolute, together with all rights, privileges, and appurtenances thereto belonging or in any way appertaining.',
      { width: PAGE_WIDTH }
    );
    spacer(12);
    para(
      '3. The Vendor further covenants and agrees to indemnify the Purchaser against any and all claims, demands, actions, costs, or liabilities whatsoever arising from or in connection with the said parcel of land, whether prior to or subsequent to the execution of this Deed.',
      { width: PAGE_WIDTH }
    );

    // ── Page 4: execution / signatures ──
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10);
    para('IN WITNESS WHEREOF, the Vendor has executed this Deed on the day and year first above written.', { width: PAGE_WIDTH });
    spacer(28);

    center('SIGNED, SEALED, AND DELIVERED');
    center(`BY THE VENDOR (${VENDOR_NAME}):`);
    spacer(40);
    center('.......................................................');
    center('DIRECTOR');
    spacer(24);

    doc.font('Helvetica-Bold').fontSize(10);
    para('SIGNED by the within-named PURCHASER on the day and year first above written:', { width: PAGE_WIDTH });
    spacer(30);
    center('.......................................................');
    center(custName.toUpperCase());
    spacer(24);

    ensureSpace(150);
    doc.font('Helvetica-Bold').fontSize(10).text('IN THE PRESENCE OF THE PURCHASER\u2019S WITNESS:', { width: PAGE_WIDTH });
    spacer(10);
    doc.font('Helvetica').fontSize(10);
    doc.text('Name: _________________________________________________________________', { width: PAGE_WIDTH });
    spacer(12);
    doc.text('Address: ______________________________________________________________', { width: PAGE_WIDTH });
    spacer(12);
    doc.text('Occupation: ___________________________________________________________', { width: PAGE_WIDTH });
    spacer(12);
    doc.text('Signature: ____________________________________________________________', { width: PAGE_WIDTH });
    spacer(30);

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('PREPARED BY:', doc.page.width - doc.page.margins.right - 180, doc.y, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(9);
    PREPARED_BY.forEach((line) => doc.text(line, doc.page.width - doc.page.margins.right - 180, doc.y, { width: 180, align: 'right' }));

    // ── Footer + page numbers on every page ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footerParts = [`Generated electronically on ${fmtDate(new Date())}`];
      if (documentNumber) footerParts.push(`Ref: ${documentNumber}`);
      if (contractCode) footerParts.push(`Contract Code: ${contractCode}`);
      footerParts.push(`Page ${i - range.start + 1} of ${range.count}`);
      doc.font('Helvetica').fontSize(8).fillColor('#666666');
      doc.text(footerParts.join(' \u2014 '), doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 10, {
        width: PAGE_WIDTH, align: 'center', lineBreak: false,
      });
      doc.fillColor('#000000');
    }

    doc.end();
  });
}
