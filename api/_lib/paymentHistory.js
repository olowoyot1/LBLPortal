// api/_lib/paymentHistory.js
// Builds a styled HTML table of a customer's payment history against a
// specific sales order, for embedding in the body of top-up receipt emails.

function ngn(n) {
  return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const MODE_LABELS = {
  banktransfer: 'Bank Transfer',
  cash: 'Cash',
  creditcard: 'Credit Card',
  cheque: 'Cheque',
  others: 'Others',
  legacy: 'Legacy / Pre-Portal',
};

/**
 * Build an HTML table summarizing every payment made against a sales order,
 * including the new payment, with a running balance after each entry.
 *
 * @param {Object} params
 * @param {Array}  params.priorPayments    transaction log entries already recorded against this SO (oldest first)
 * @param {Object} params.newPayment       the payment just processed: { date, amount, mode }
 * @param {number} params.contractTotal    full contract value for this sales order
 * @param {string} [params.soNumber]
 * @returns {{ html: string, totalPaid: number, remainingBalance: number }}
 */
export function buildPaymentHistoryTable({ priorPayments = [], newPayment, contractTotal, soNumber }) {
  const rows = [
    ...priorPayments.map((t) => ({
      date: t.timestamp || t.payDate,
      amount: Number(t.amtPaid) || 0,
      mode: t.payMode,
    })),
    {
      date: newPayment.date,
      amount: Number(newPayment.amount) || 0,
      mode: newPayment.mode,
      isNew: true,
    },
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let running = 0;
  const bodyRows = rows.map((r) => {
    running += r.amount;
    const balance = Math.max(0, Number(contractTotal || 0) - running);
    const rowBg = r.isNew ? '#FFF8E7' : '#FFFFFF';
    const rowLabel = r.isNew ? ' <span style="color:#B8860B;font-weight:600;">(this payment)</span>' : '';
    return `
      <tr style="background:${rowBg};">
        <td style="padding:10px 12px;border-bottom:1px solid #EEE;font-size:13px;color:#333;">${fmtDate(r.date)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #EEE;font-size:13px;color:#333;">${MODE_LABELS[r.mode] || r.mode || '—'}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #EEE;font-size:13px;color:#1a7a3c;text-align:right;font-weight:600;">${ngn(r.amount)}${rowLabel}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #EEE;font-size:13px;color:#333;text-align:right;">${ngn(balance)}</td>
      </tr>`;
  }).join('');

  const totalPaid = running;
  const remainingBalance = Math.max(0, Number(contractTotal || 0) - totalPaid);

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:16px 0;">
    <div style="font-size:14px;font-weight:700;color:#222;margin-bottom:8px;">
      Payment History${soNumber ? ' &mdash; ' + soNumber : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #EEE;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#1F2937;">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#FFFFFF;font-weight:600;">Date</th>
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#FFFFFF;font-weight:600;">Mode</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#FFFFFF;font-weight:600;">Amount Paid</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#FFFFFF;font-weight:600;">Balance Remaining</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
      <tfoot>
        <tr style="background:#F9FAFB;">
          <td colspan="2" style="padding:10px 12px;font-size:13px;font-weight:700;color:#222;">Total Paid to Date</td>
          <td style="padding:10px 12px;font-size:13px;font-weight:700;color:#1a7a3c;text-align:right;">${ngn(totalPaid)}</td>
          <td style="padding:10px 12px;font-size:13px;font-weight:700;color:#B22222;text-align:right;">${ngn(remainingBalance)}</td>
        </tr>
      </tfoot>
    </table>
    <div style="font-size:11px;color:#888;margin-top:6px;">
      Contract value: ${ngn(contractTotal)}
    </div>
  </div>`;

  return { html, totalPaid, remainingBalance };
}
