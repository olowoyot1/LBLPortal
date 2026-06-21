const API = window.API_BASE_URL;

// ── fetch helper ──
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return body;
}

// ── utils ──
function fmt(n) { return 'NGN ' + Number(n).toLocaleString('en-NG'); }
function el(id) { return document.getElementById(id); }
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }
function modeLabel(m) {
  return { banktransfer: 'Bank Transfer', cash: 'Cash', creditcard: 'Credit Card', cheque: 'Cheque', others: 'Others' }[m] || m;
}

// ── auth ──
let currentUser = null;

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  const btn = el('login-submit');
  el('login-error').textContent = '';
  if (!username || !password) {
    el('login-error').textContent = 'Enter your username and password.';
    return;
  }
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    currentUser = user;
    enterApp();
  } catch (err) {
    el('login-error').textContent = err.message;
  }
  btn.disabled = false; btn.textContent = 'Sign In';
});

async function tryResumeSession() {
  try {
    const user = await api('/api/auth/me');
    currentUser = user;
    enterApp();
  } catch {
    // not logged in — stay on login screen
  }
}

function enterApp() {
  el('nav-user').textContent = `${currentUser.displayName} · ${currentUser.role}`;
  el('clear-log-btn').classList.toggle('hidden', currentUser.role === 'realtor');
  el('tab-staff').classList.toggle('hidden', currentUser.role !== 'admin');
  el('login-screen').style.display = 'none';
  el('app').style.display = 'block';
  renderLog();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  currentUser = null;
  el('app').style.display = 'none';
  el('login-screen').style.display = 'flex';
  el('login-username').value = '';
  el('login-password').value = '';
}

// ── state ──
let S = { custType: null, txType: null, customer: null, salesOrder: null, newCust: {}, prop: {}, payment: {} };

// ── tabs ──
function switchTab(t) {
  ['payment', 'log', 'staff'].forEach((x) => {
    el('tab-' + x)?.classList.toggle('active', x === t);
    el('view-' + x)?.classList.toggle('active', x === t);
  });
  if (t === 'log') renderLog();
  if (t === 'staff') renderStaff();
}

// ── steps ──
function setStep(n) {
  [1, 2, 3, 4, 5].forEach((i) => { if (el('step' + i)) el('step' + i).classList.add('hidden'); });
  hide('step5');
  if (n <= 4) show('step' + n); else show('step5');
  [1, 2, 3, 4].forEach((i) => {
    const si = el('si-' + i);
    si.classList.remove('active', 'done');
    if (i < n) si.classList.add('done');
    if (i === n) si.classList.add('active');
  });
}

// ── STEP 1 ──
function setCustType(t) {
  S.custType = t;
  el('btn-existing').classList.toggle('active', t === 'existing');
  el('btn-new').classList.toggle('active', t === 'new');
  if (t === 'existing') {
    show('existing-search'); hide('new-cust-form'); el('next1').disabled = !S.customer;
  } else {
    hide('existing-search'); show('new-cust-form'); el('next1').disabled = false; S.customer = null;
  }
}

async function searchCustomer() {
  const name = el('search-name').value.trim();
  if (!name) return;
  const btn = el('search-btn');
  btn.disabled = true; btn.textContent = '...';
  el('search-results').innerHTML = '<span style="font-size:12px;color:var(--muted)"><span class="spinner"></span>Searching...</span>';
  try {
    const results = await api(`/api/customers/search?name=${encodeURIComponent(name)}`);
    if (!results.length) {
      el('search-results').innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">No customers found. Try different spelling or create new.</div>';
    } else {
      el('search-results').innerHTML = results.map((c) => `
        <div class="result-item" id="cr-${c.customer_id}" data-customer='${JSON.stringify(c).replace(/'/g, "&#39;")}' onclick="selectCustomerFromEl(this)">
          <div>
            <div class="r-name">${escapeHtml(c.customer_name)}</div>
            <div class="r-meta">${escapeHtml(c.email || 'No email')}${c.phone ? ' · ' + escapeHtml(c.phone) : ''}</div>
          </div>
          <span style="color:var(--muted)">›</span>
        </div>`).join('');
    }
  } catch (e) {
    el('search-results').innerHTML = `<div style="color:var(--red);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = 'Search';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function selectCustomerFromEl(node) {
  const c = JSON.parse(node.getAttribute('data-customer'));
  selectCustomer(c);
}

function selectCustomer(c) {
  S.customer = c;
  document.querySelectorAll('#existing-search .result-item').forEach((x) => x.classList.remove('selected'));
  const t = el('cr-' + c.customer_id); if (t) t.classList.add('selected');
  el('next1').disabled = false;
}

function goStep2() {
  if (S.custType === 'new') {
    const name = el('new-name').value.trim();
    if (!name) { alert('Please enter customer name'); return; }
    S.newCust = { name, email: el('new-email').value.trim(), phone: el('new-phone').value.trim(), address: el('new-address').value.trim() };
    S.customer = { customer_name: name, isNew: true };
  }
  if (!S.customer) { alert('Please select or create a customer'); return; }
  S.txType = null; S.salesOrder = null;
  ['btn-topup', 'btn-outright', 'btn-installment'].forEach((b) => el(b).classList.remove('active'));
  hide('so-picker'); el('next2').disabled = true;
  el('btn-topup').style.display = S.custType === 'new' ? 'none' : 'flex';
  setStep(2);
}
function goStep1() { setStep(1); }

// ── STEP 2 ──
function setTxType(t) {
  S.txType = t;
  ['btn-topup', 'btn-outright', 'btn-installment'].forEach((b) => el(b).classList.remove('active'));
  el('btn-' + t).classList.add('active');
  if (t === 'topup') { show('so-picker'); loadOpenSalesOrders(); el('next2').disabled = true; }
  else { hide('so-picker'); el('next2').disabled = false; }
}

async function loadOpenSalesOrders() {
  show('so-loading'); el('so-list').innerHTML = '';
  try {
    const cId = S.customer.customer_id;
    const orders = await api(`/api/sales-orders?customerId=${encodeURIComponent(cId)}`);
    hide('so-loading');
    if (!orders.length) {
      el('so-list').innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">No open sales orders found for this customer.</div>';
    } else {
      el('so-list').innerHTML = orders.map((o) => `
        <div class="result-item" id="so-${o.salesorder_id}" data-so='${JSON.stringify(o).replace(/'/g, "&#39;")}' onclick="selectSOFromEl(this)">
          <div>
            <div class="r-name">${escapeHtml(o.salesorder_number)}${o.subject ? ' · ' + escapeHtml(o.subject) : ''}</div>
            <div class="r-meta">Total: ${fmt(o.total)} · Balance: ${fmt(o.balance_due || o.total)} · ${o.date}</div>
          </div>
          <span class="badge badge-open">${escapeHtml(o.status || 'open')}</span>
        </div>`).join('');
    }
  } catch (e) {
    hide('so-loading');
    el('so-list').innerHTML = `<div style="color:var(--red);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
}

function selectSOFromEl(node) {
  const o = JSON.parse(node.getAttribute('data-so'));
  selectSO(o);
}

function selectSO(o) {
  S.salesOrder = o;
  document.querySelectorAll('#so-list .result-item').forEach((x) => x.classList.remove('selected'));
  const t = el('so-' + o.salesorder_id); if (t) t.classList.add('selected');
  el('next2').disabled = false;
}

function goStep3() {
  if (!S.txType) { alert('Please select a transaction type'); return; }
  if (S.txType === 'topup' && !S.salesOrder) { alert('Please select a sales order'); return; }
  const isTopup = S.txType === 'topup';
  if (isTopup) {
    hide('prop-desc-row'); show('topup-so-display'); hide('full-price-row');
    el('topup-so-display').className = 'info-box';
    el('topup-so-display').innerHTML = `<strong>Sales Order:</strong> ${escapeHtml(S.salesOrder.salesorder_number)}<br><strong>Property:</strong> ${escapeHtml(S.salesOrder.subject || 'See sales order')}<br><strong>Total Contract:</strong> ${fmt(S.salesOrder.total)}<br><strong>Remaining Balance:</strong> ${fmt(S.salesOrder.balance_due || S.salesOrder.total)}`;
    el('topup-so-display').style.marginBottom = '0';
  } else {
    show('prop-desc-row'); el('topup-so-display').innerHTML = ''; show('full-price-row');
    el('full-price-label').textContent = S.txType === 'installment'
      ? 'Full Property Price (NGN) * — for sales order'
      : 'Full Property Price (NGN) *';
  }
  el('pay-date').value = new Date().toISOString().split('T')[0];
  setStep(3);
}

// ── STEP 4 ──
function goStep4() {
  const amt = parseFloat(el('amount-paid').value);
  const date = el('pay-date').value;
  if (!amt || !date) { alert('Please fill in amount and payment date'); return; }
  const isTopup = S.txType === 'topup';
  const propDesc = isTopup ? (S.salesOrder.subject || 'See sales order') : el('prop-desc').value.trim();
  const fullPrice = isTopup ? S.salesOrder.total : parseFloat(el('full-price').value || 0);
  if (!isTopup && !propDesc) { alert('Please enter property description'); return; }
  if (!isTopup && !fullPrice) { alert('Please enter full property price'); return; }
  S.payment = { amtPaid: amt, payDate: date, payMode: el('pay-mode').value, payRef: el('pay-ref').value.trim(), salesperson: el('salesperson').value.trim(), notes: el('pay-notes').value.trim() };
  S.prop = { propDesc, fullPrice };

  const custName = S.custType === 'new' ? S.newCust.name : S.customer.customer_name;
  const txLabels = { topup: 'Installment Top-up', outright: 'Outright Purchase', installment: 'New Installment' };
  const docsText = { outright: '① Payment receipt<br>② Invoice (full property price)', installment: '① Payment receipt (initial deposit)<br>② Sales Order (full contract value)', topup: '① Payment receipt only' };

  el('review-card').innerHTML = `
    <div class="card-title">Review Before Confirming</div>
    <div class="s-row"><div class="s-icon ok">👤</div><div><div class="s-label">${escapeHtml(custName)}</div><div class="s-sub">${S.custType === 'new' ? 'New customer — will be created' : 'Existing customer · ID: ' + escapeHtml(S.customer.customer_id)}</div></div></div>
    <div class="s-row"><div class="s-icon ok">🏷</div><div><div class="s-label">${txLabels[S.txType]}</div><div class="s-sub">${escapeHtml(propDesc)}</div></div></div>
    ${!isTopup ? `<div class="s-row"><div class="s-icon ok">📊</div><div><div class="s-label">Full property value</div><div class="s-sub">${fmt(fullPrice)}</div></div></div>` : ''}
    ${isTopup ? `<div class="s-row"><div class="s-icon ok">📋</div><div><div class="s-label">Sales Order: ${escapeHtml(S.salesOrder.salesorder_number)}</div><div class="s-sub">Balance: ${fmt(S.salesOrder.balance_due || S.salesOrder.total)}</div></div></div>` : ''}
    <div class="s-row"><div class="s-icon ok">💰</div><div><div class="s-label">Amount Paid: ${fmt(amt)}</div><div class="s-sub">${modeLabel(S.payment.payMode)}${S.payment.payRef ? ' · Ref: ' + escapeHtml(S.payment.payRef) : ''} · ${date}</div></div></div>
    ${S.payment.salesperson ? `<div class="s-row"><div class="s-icon ok">👔</div><div><div class="s-label">Realtor</div><div class="s-sub">${escapeHtml(S.payment.salesperson)}</div></div></div>` : ''}
    <div class="s-row"><div class="s-icon ok">📝</div><div><div class="s-label">Documents to be created</div><div class="s-sub">${docsText[S.txType]}</div></div></div>
  `;
  hide('error-box'); setStep(4);
}

// ── PROCESS ──
async function processPayment() {
  const btn = el('confirm-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Processing...';
  hide('error-box');

  const payload = {
    custType: S.custType,
    txType: S.txType,
    customer: S.customer,
    newCust: S.newCust,
    salesOrder: S.salesOrder,
    propDesc: S.prop.propDesc,
    fullPrice: S.prop.fullPrice,
    amtPaid: S.payment.amtPaid,
    payDate: S.payment.payDate,
    payMode: S.payment.payMode,
    payRef: S.payment.payRef,
    salesperson: S.payment.salesperson,
    notes: S.payment.notes
  };

  try {
    const result = await api('/api/payments/process', { method: 'POST', body: JSON.stringify(payload) });
    const docLabels = { invoice: 'Invoice', sales_order: 'Sales Order', receipt_only: 'Receipt Only' };
    setStep(5);
    el('success-content').innerHTML = `
      <div style="text-align:center;padding:1rem 0 1.5rem">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-size:16px;font-weight:500;color:var(--green)">Payment Processed Successfully</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${new Date(result.timestamp).toLocaleString('en-NG')} · ${escapeHtml(result.realtor)}</div>
      </div>
      <div class="s-row"><div class="s-icon ok">👤</div><div><div class="s-label">${escapeHtml(result.custName)}</div><div class="s-sub">${result.custCreated ? 'New customer created · ' : ''}ID: ${escapeHtml(result.custId)}</div></div></div>
      <div class="s-row"><div class="s-icon ok">🧾</div><div><div class="s-label">Payment receipt recorded &amp; verified</div><div class="s-sub">${fmt(result.amtPaid)} · ${modeLabel(result.payMode)}${result.payRef ? ' · Ref: ' + escapeHtml(result.payRef) : ''}</div><span class="doc-chip">${escapeHtml(result.paymentId)}</span></div></div>
      ${result.docType !== 'receipt_only'
        ? `<div class="s-row"><div class="s-icon ok">📄</div><div><div class="s-label">${docLabels[result.docType]} generated &amp; verified</div>${result.docType === 'sales_order' ? `<div class="s-sub">Full contract: ${fmt(result.fullPrice)}</div>` : ''}<span class="doc-chip">${escapeHtml(result.docNumber || result.docId)}</span></div></div>`
        : `<div class="s-row"><div class="s-icon ok">📋</div><div><div class="s-label">Top-up applied to ${escapeHtml(result.soNumber || '')}</div><div class="s-sub">Receipt only — no new document created</div></div></div>`}
    `;
  } catch (e) {
    el('error-box').className = 'err-box';
    el('error-box').innerHTML = `<strong>Error:</strong> ${escapeHtml(e.message)}`;
    show('error-box');
  }
  btn.disabled = false; btn.innerHTML = 'Confirm &amp; Process ✓';
}

function resetPayment() {
  S = { custType: null, txType: null, customer: null, salesOrder: null, newCust: {}, prop: {}, payment: {} };
  ['btn-existing', 'btn-new'].forEach((b) => el(b).classList.remove('active'));
  ['btn-topup', 'btn-outright', 'btn-installment'].forEach((b) => el(b).classList.remove('active'));
  hide('existing-search'); hide('new-cust-form'); hide('so-picker');
  el('next1').disabled = true;
  el('search-name').value = ''; el('search-results').innerHTML = ''; el('so-list').innerHTML = '';
  ['new-name', 'new-email', 'new-phone', 'new-address', 'prop-desc', 'full-price', 'amount-paid', 'pay-ref', 'salesperson', 'pay-notes'].forEach((id) => { if (el(id)) el(id).value = ''; });
  setStep(1);
}

// ── LOG (server-backed, not localStorage) ──
async function renderLog() {
  el('log-body').innerHTML = '<div class="log-empty"><span class="spinner"></span>Loading...</div>';
  let log = [];
  try {
    log = await api('/api/transactions');
  } catch (e) {
    el('log-body').innerHTML = `<div class="log-empty" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
    return;
  }

  const totalAmt = log.reduce((s, e) => s + e.amtPaid, 0);
  const byType = (t) => log.filter((e) => e.txType === t).length;
  el('log-stats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total transactions</div><div class="stat-value">${log.length}</div></div>
    <div class="stat-card"><div class="stat-label">Total collected</div><div class="stat-value" style="font-size:14px">${fmt(totalAmt)}</div></div>
    <div class="stat-card"><div class="stat-label">New purchases</div><div class="stat-value">${byType('outright') + byType('installment')}</div></div>
    <div class="stat-card"><div class="stat-label">Top-ups</div><div class="stat-value">${byType('topup')}</div></div>
  `;

  if (!log.length) {
    el('log-body').innerHTML = '<div class="log-empty">No transactions yet. Confirmed payments will appear here.</div>';
    return;
  }

  const txLabels = { topup: 'Top-up', outright: 'Outright', installment: 'Installment' };
  el('log-body').innerHTML = `
    <table class="log-table">
      <thead><tr>
        <th>Date</th><th>Customer</th><th>Type</th><th>Amount Paid</th><th>Document</th><th>Realtor</th>
      </tr></thead>
      <tbody>${log.map((e) => `
        <tr>
          <td style="white-space:nowrap;color:var(--muted)">${new Date(e.timestamp).toLocaleDateString('en-NG')}</td>
          <td><div style="font-weight:500">${escapeHtml(e.custName)}</div>${e.custCreated ? '<div style="font-size:10px;color:var(--gold)">New</div>' : ''}</td>
          <td><span class="tx-badge tx-${e.txType}">${txLabels[e.txType] || e.txType}</span></td>
          <td style="font-family:'DM Mono',monospace;font-size:12px">${fmt(e.amtPaid)}</td>
          <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--gold)">${escapeHtml(e.docNumber || e.paymentId || '—')}${e.soNumber ? '<br><span style="color:var(--muted)">SO: ' + escapeHtml(e.soNumber) + '</span>' : ''}</td>
          <td style="color:var(--muted)">${escapeHtml(e.realtor || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function clearLog() {
  if (!confirm('Clear all transaction log entries? This cannot be undone.')) return;
  try {
    await api('/api/transactions', { method: 'DELETE' });
    renderLog();
  } catch (e) {
    alert(e.message);
  }
}

async function exportCSV() {
  let log = [];
  try { log = await api('/api/transactions'); } catch (e) { alert(e.message); return; }
  if (!log.length) { alert('No transactions to export.'); return; }
  const headers = ['Timestamp', 'Realtor', 'Customer', 'Customer ID', 'New Customer', 'Tx Type', 'Property', 'Amount Paid', 'Full Price', 'Payment Mode', 'Reference', 'Document Type', 'Document Number', 'Payment ID', 'SO Number'];
  const rows = log.map((e) => [
    new Date(e.timestamp).toLocaleString('en-NG'),
    e.realtor, e.custName, e.custId, e.custCreated ? 'Yes' : 'No',
    e.txType, e.propDesc || '', e.amtPaid, e.fullPrice || '',
    modeLabel(e.payMode), e.payRef || '', e.docType || '',
    e.docNumber || '', e.paymentId || '', e.soNumber || ''
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `landblaze_transactions_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── STAFF MANAGEMENT (admin only) ──

async function renderStaff() {
  el('staff-body').innerHTML = '<div class="log-empty"><span class="spinner"></span>Loading...</div>';
  try {
    const users = await api('/api/staff');
    if (!users.length) {
      el('staff-body').innerHTML = '<div class="log-empty">No staff accounts found.</div>';
      return;
    }
    const roleColors = { admin: 'tx-outright', manager: 'tx-installment', realtor: 'tx-topup' };
    el('staff-body').innerHTML = `
      <table class="log-table">
        <thead><tr>
          <th>Username</th><th>Display Name</th><th>Role</th><th>Created</th><th></th>
        </tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td style="font-family:'DM Mono',monospace;font-size:12px">${escapeHtml(u.username)}</td>
            <td style="font-weight:500">${escapeHtml(u.displayName)}</td>
            <td><span class="tx-badge ${roleColors[u.role] || ''}">${escapeHtml(u.role)}</span></td>
            <td style="color:var(--muted);font-size:11px">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-NG') : '—'}</td>
            <td>${u.username !== currentUser.username
              ? `<button onclick="deleteUser('${escapeHtml(u.username)}')" style="background:transparent;border:0.5px solid var(--red-border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--red);cursor:pointer;font-family:'DM Sans',sans-serif">Remove</button>`
              : '<span style="font-size:11px;color:var(--muted)">You</span>'
            }</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el('staff-body').innerHTML = `<div class="log-empty" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

function showCreateUserForm() {
  ['su-username', 'su-name', 'su-password'].forEach((id) => { el(id).value = ''; });
  el('su-role').value = 'realtor';
  el('su-error').classList.add('hidden');
  el('create-user-card').classList.remove('hidden');
  el('su-username').focus();
}

function hideCreateUserForm() {
  el('create-user-card').classList.add('hidden');
}

async function submitCreateUser() {
  const username = el('su-username').value.trim();
  const displayName = el('su-name').value.trim();
  const password = el('su-password').value;
  const role = el('su-role').value;

  el('su-error').classList.add('hidden');
  if (!username || !displayName || !password) {
    el('su-error').textContent = 'All fields are required.';
    el('su-error').classList.remove('hidden');
    return;
  }
  if (password.length < 8) {
    el('su-error').textContent = 'Password must be at least 8 characters.';
    el('su-error').classList.remove('hidden');
    return;
  }

  const btn = el('su-submit');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    await api('/api/staff', { method: 'POST', body: JSON.stringify({ username, displayName, password, role }) });
    hideCreateUserForm();
    renderStaff();
  } catch (e) {
    el('su-error').textContent = e.message;
    el('su-error').classList.remove('hidden');
  }
  btn.disabled = false; btn.textContent = 'Create Account';
}

async function deleteUser(username) {
  if (!confirm(`Remove staff account "${username}"? They will no longer be able to log in.`)) return;
  try {
    await api(`/api/staff?username=${encodeURIComponent(username)}`, { method: 'DELETE' });
    renderStaff();
  } catch (e) {
    alert(e.message);
  }
}

// ── init ──
tryResumeSession();
