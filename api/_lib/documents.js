// api/_lib/documents.js
// Small helpers so callers don't repeat the invoice-vs-sales-order
// branching every time they attach a generated document. Deliberately
// kept as TWO separate functions rather than one combined "attach
// everything" helper, because the Contract of Sale goes out with every
// sale, while the Deed of Conveyance (see api/_lib/deed.js) must only ever
// be attached once a property is fully paid for — callers decide when
// that is (isFinalPayment) and call attachDeed accordingly, never
// automatically.
import * as zoho from './zoho.js';

export async function attachContract({ docKind, docId, contractPdf, fileName = 'Contract_of_Sale.pdf' }) {
  if (docKind === 'invoice') {
    await zoho.attachContractToInvoice(docId, contractPdf, fileName);
  } else {
    await zoho.attachContractToSalesOrder(docId, contractPdf, fileName);
  }
}

export async function attachDeed({ docKind, docId, deedPdf, fileName = 'Deed_of_Conveyance.pdf' }) {
  if (docKind === 'invoice') {
    await zoho.attachDeedOfAssignmentToInvoice(docId, deedPdf, fileName, 'application/pdf');
  } else {
    await zoho.attachDeedOfAssignmentToSalesOrder(docId, deedPdf, fileName, 'application/pdf');
  }
}
