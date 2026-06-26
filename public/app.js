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
let S = { custType: null, txType: null, customer: null, salesOrder: null, newCust: {}, prop: {}, payment: {}, item: null, bankAccount: null };

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
    const results = await api(`/api/customers?name=${encodeURIComponent(name)}`);
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
    const email = el('new-email').value.trim();
    const phone = el('new-phone').value.trim();
    const address = el('new-address').value.trim();
    const missing = [];
    if (!name) missing.push('Full Name');
    if (!email) missing.push('Email');
    if (!phone) missing.push('Phone');
    if (!address) missing.push('Address');
    if (missing.length) { alert(`Please fill in: ${missing.join(', ')}.\n\nEmail, phone, and address are required so we can send the customer their receipt, invoice, or sales order.`); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { alert('Please enter a valid email address.'); return; }
    S.newCust = { name, email, phone, address };
    S.customer = { customer_name: name, email, phone, isNew: true };
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
            <div class="r-meta">Total: ${fmt(o.total)} · Paid: ${fmt(o.paid_so_far ?? 0)} · Balance: ${fmt(o.balance_due ?? o.total)} · ${o.date}</div>
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
  S.item = null;
  if (isTopup) {
    hide('prop-desc-row'); hide('plot-size-row'); show('topup-so-display'); hide('full-price-row');
    el('topup-so-display').className = 'info-box';
    el('topup-so-display').innerHTML = `<strong>Sales Order:</strong> ${escapeHtml(S.salesOrder.salesorder_number)}<br><strong>Property:</strong> ${escapeHtml(S.salesOrder.subject || 'See sales order')}<br><strong>Total Contract:</strong> ${fmt(S.salesOrder.total)}<br><strong>Paid So Far:</strong> ${fmt(S.salesOrder.paid_so_far ?? 0)}<br><strong>Remaining Balance:</strong> ${fmt(S.salesOrder.balance_due ?? S.salesOrder.total)}`;
    el('topup-so-display').style.marginBottom = '0';
  } else {
    show('prop-desc-row'); show('plot-size-row'); el('topup-so-display').innerHTML = ''; show('full-price-row');
    el('full-price-label').textContent = S.txType === 'installment'
      ? 'Full Property Price (NGN) * — for sales order'
      : 'Full Property Price (NGN) *';
    el('prop-desc').value = '';
    el('plot-size').value = '';
    el('item-results').innerHTML = '';
  }
  el('pay-date').value = new Date().toISOString().split('T')[0];
  loadBankAccounts();
  onPayModeChange();
  setStep(3);
}

// ── ITEM SEARCH (Zoho Books Items) ──
let itemSearchTimer = null;
el('prop-desc').addEventListener('input', () => {
  S.item = null; // typing again invalidates a prior selection
  clearTimeout(itemSearchTimer);
  const q = el('prop-desc').value.trim();
  if (!q) { el('item-results').innerHTML = ''; return; }
  itemSearchTimer = setTimeout(() => searchItemsForInput(q), 300);
});

async function searchItemsForInput(q) {
  el('item-results').innerHTML = '<span style="font-size:12px;color:var(--muted)"><span class="spinner"></span>Searching items...</span>';
  try {
    const results = await api(`/api/items?name=${encodeURIComponent(q)}`);
    if (!results.length) {
      el('item-results').innerHTML = '<div style="font-size:12px;color:var(--muted);padding:6px 0">No matching item in Zoho Books. You can still type a custom description.</div>';
    } else {
      el('item-results').innerHTML = results.map((i) => `
        <div class="result-item" id="ir-${i.item_id}" data-item='${JSON.stringify(i).replace(/'/g, "&#39;")}' onclick="selectItemFromEl(this)">
          <div>
            <div class="r-name">${escapeHtml(i.name)}</div>
            <div class="r-meta">${fmt(i.rate || 0)}${i.unit ? ' / ' + escapeHtml(i.unit) : ''}</div>
          </div>
          <span style="color:var(--muted)">›</span>
        </div>`).join('');
    }
  } catch (e) {
    el('item-results').innerHTML = `<div style="color:var(--red);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
}

function selectItemFromEl(node) {
  const i = JSON.parse(node.getAttribute('data-item'));
  S.item = i;
  el('prop-desc').value = i.name;
  el('item-results').innerHTML = '';
  if (i.rate && el('full-price') && !el('full-price-row').classList.contains('hidden')) {
    el('full-price').value = i.rate;
  }
}

// ── BANK ACCOUNTS (Zoho Books) ──
async function loadBankAccounts() {
  const sel = el('bank-account');
  sel.innerHTML = '<option value="">Loading bank accounts...</option>';
  try {
    const accounts = await api('/api/bank-accounts');
    if (!accounts.length) {
      sel.innerHTML = '<option value="">No bank accounts found in Zoho Books</option>';
      return;
    }
    sel.innerHTML = '<option value="">Select bank account...</option>' +
      accounts.map((a) => `<option value='${a.account_id}'>${escapeHtml(a.account_name)}${a.bank_name ? ' — ' + escapeHtml(a.bank_name) : ''}</option>`).join('');
    sel._accounts = accounts;
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${escapeHtml(e.message)}</option>`;
  }
}

function onPayModeChange() {
  const mode = el('pay-mode').value;
  // Bank account only meaningfully applies to bank transfer / cheque deposits
  show('bank-account-row');
  el('bank-account-row').style.display = (mode === 'cash') ? 'none' : '';
}

// ── STEP 4 ──
function goStep4() {
  const amt = parseFloat(el('amount-paid').value);
  const date = el('pay-date').value;
  if (!amt || !date) { alert('Please fill in amount and payment date'); return; }
  const isTopup = S.txType === 'topup';
  const propDesc = isTopup ? (S.salesOrder.subject || 'See sales order') : el('prop-desc').value.trim();
  const plotSize = isTopup ? '' : el('plot-size').value.trim();
  const fullPrice = isTopup ? S.salesOrder.total : parseFloat(el('full-price').value || 0);
  if (!isTopup && !propDesc) { alert('Please enter or select a property/item'); return; }
  if (!isTopup && !fullPrice) { alert('Please enter full property price'); return; }

  const payMode = el('pay-mode').value;
  const bankSel = el('bank-account');
  let bankAccount = null;
  if (payMode !== 'cash') {
    if (!bankSel.value) { alert('Please select the bank account this payment was deposited into'); return; }
    const accounts = bankSel._accounts || [];
    bankAccount = accounts.find((a) => a.account_id === bankSel.value) || { account_id: bankSel.value };
  }

  S.payment = { amtPaid: amt, payDate: date, payMode, payRef: el('pay-ref').value.trim(), salesperson: el('salesperson').value.trim(), notes: el('pay-notes').value.trim() };
  S.prop = { propDesc, plotSize, fullPrice };
  S.bankAccount = bankAccount;

  const custName = S.custType === 'new' ? S.newCust.name : S.customer.customer_name;
  const custEmail = S.custType === 'new' ? S.newCust.email : S.customer.email;
  const txLabels = { topup: 'Installment Top-up', outright: 'Outright Purchase', installment: 'New Installment' };
  const docsText = { outright: '① Payment receipt (emailed)<br>② Invoice (sent &amp; emailed)', installment: '① Payment receipt (emailed)<br>② Sales Order (sent &amp; emailed)', topup: '① Payment receipt (emailed)' };

  el('review-card').innerHTML = `
    <div class="card-title">Review Before Confirming</div>
    <div class="s-row"><div class="s-icon ok">👤</div><div><div class="s-label">${escapeHtml(custName)}</div><div class="s-sub">${S.custType === 'new' ? 'New customer — will be created · ' + escapeHtml(custEmail || 'no email') : 'Existing customer · ID: ' + escapeHtml(S.customer.customer_id)}</div></div></div>
    <div class="s-row"><div class="s-icon ok">🏷</div><div><div class="s-label">${txLabels[S.txType]}</div><div class="s-sub">${escapeHtml(propDesc)}${plotSize ? ' · ' + escapeHtml(plotSize) : ''}</div></div></div>
    ${!isTopup ? `<div class="s-row"><div class="s-icon ok">📊</div><div><div class="s-label">Full property value</div><div class="s-sub">${fmt(fullPrice)}</div></div></div>` : ''}
    ${isTopup ? `<div class="s-row"><div class="s-icon ok">📋</div><div><div class="s-label">Sales Order: ${escapeHtml(S.salesOrder.salesorder_number)}</div><div class="s-sub">Balance before this payment: ${fmt(S.salesOrder.balance_due ?? S.salesOrder.total)}</div></div></div>` : ''}
    <div class="s-row"><div class="s-icon ok">💰</div><div><div class="s-label">Amount Paid: ${fmt(amt)}</div><div class="s-sub">${modeLabel(S.payment.payMode)}${bankAccount ? ' · ' + escapeHtml(bankAccount.account_name || '') : ''}${S.payment.payRef ? ' · Ref: ' + escapeHtml(S.payment.payRef) : ''} · ${date}</div></div></div>
    ${S.payment.salesperson ? `<div class="s-row"><div class="s-icon ok">👔</div><div><div class="s-label">Realtor</div><div class="s-sub">${escapeHtml(S.payment.salesperson)}</div></div></div>` : ''}
    <div class="s-row"><div class="s-icon ok">📝</div><div><div class="s-label">Documents to be created &amp; sent</div><div class="s-sub">${docsText[S.txType]}</div></div></div>
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
    plotSize: S.prop.plotSize,
    item: S.item,
    fullPrice: S.prop.fullPrice,
    amtPaid: S.payment.amtPaid,
    payDate: S.payment.payDate,
    payMode: S.payment.payMode,
    bankAccount: S.bankAccount,
    payRef: S.payment.payRef,
    salesperson: S.payment.salesperson,
    notes: S.payment.notes
  };

  try {
    const result = await api('/api/payments/process', { method: 'POST', body: JSON.stringify(payload) });
    const docLabels = { invoice: 'Invoice', sales_order: 'Sales Order', receipt_only: 'Receipt Only' };
    setStep(5);
    const emailRow = result.emailSent
      ? `<div class="s-row"><div class="s-icon ok">📧</div><div><div class="s-label">Emailed to customer</div><div class="s-sub">${escapeHtml(result.custEmail || '')}</div></div></div>`
      : `<div class="s-row"><div class="s-icon" style="background:var(--red-bg)">⚠️</div><div><div class="s-label" style="color:var(--red)">Could not email customer</div><div class="s-sub">${escapeHtml((result.emailErrors || []).join(' · ') || 'No email on file')}</div></div></div>`;
    el('success-content').innerHTML = `
      <div style="text-align:center;padding:1rem 0 1.5rem">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-size:16px;font-weight:500;color:var(--green)">Payment Processed Successfully</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${new Date(result.timestamp).toLocaleString('en-NG')} · ${escapeHtml(result.realtor)}</div>
      </div>
      <div class="s-row"><div class="s-icon ok">👤</div><div><div class="s-label">${escapeHtml(result.custName)}</div><div class="s-sub">${result.custCreated ? 'New customer created · ' : ''}ID: ${escapeHtml(result.custId)}</div></div></div>
      <div class="s-row"><div class="s-icon ok">🧾</div><div><div class="s-label">Payment receipt recorded &amp; verified</div><div class="s-sub">${fmt(result.amtPaid)} · ${modeLabel(result.payMode)}${result.bankAccountName ? ' · ' + escapeHtml(result.bankAccountName) : ''}${result.payRef ? ' · Ref: ' + escapeHtml(result.payRef) : ''}</div><span class="doc-chip">${escapeHtml(result.paymentId)}</span></div></div>
      ${result.docType !== 'receipt_only'
        ? `<div class="s-row"><div class="s-icon ok">📄</div><div><div class="s-label">${docLabels[result.docType]} sent to customer &amp; verified</div>${result.docType === 'sales_order' ? `<div class="s-sub">Full contract: ${fmt(result.fullPrice)}</div>` : ''}<span class="doc-chip">${escapeHtml(result.docNumber || result.docId)}</span></div></div>`
        : `<div class="s-row"><div class="s-icon ok">📋</div><div><div class="s-label">Top-up applied to ${escapeHtml(result.soNumber || '')}</div><div class="s-sub">Remaining balance: ${fmt(result.soRemainingBalance ?? 0)}</div></div></div>`}
      ${emailRow}
    `;
  } catch (e) {
    el('error-box').className = 'err-box';
    el('error-box').innerHTML = `<strong>Error:</strong> ${escapeHtml(e.message)}`;
    show('error-box');
  }
  btn.disabled = false; btn.innerHTML = 'Confirm &amp; Process ✓';
}

function resetPayment() {
  S = { custType: null, txType: null, customer: null, salesOrder: null, newCust: {}, prop: {}, payment: {}, item: null, bankAccount: null };
  ['btn-existing', 'btn-new'].forEach((b) => el(b).classList.remove('active'));
  ['btn-topup', 'btn-outright', 'btn-installment'].forEach((b) => el(b).classList.remove('active'));
  hide('existing-search'); hide('new-cust-form'); hide('so-picker');
  el('next1').disabled = true;
  el('search-name').value = ''; el('search-results').innerHTML = ''; el('so-list').innerHTML = ''; el('item-results').innerHTML = '';
  ['new-name', 'new-email', 'new-phone', 'new-address', 'prop-desc', 'plot-size', 'full-price', 'amount-paid', 'pay-ref', 'salesperson', 'pay-notes'].forEach((id) => { if (el(id)) el(id).value = ''; });
  setStep(1);
}

// ── LOG (server-backed, not localStorage) ──
let logCache = [];

async function renderLog() {
  el('log-body').innerHTML = '<div class="log-empty"><span class="spinner"></span>Loading...</div>';
  let log = [];
  try {
    log = await api('/api/transactions');
  } catch (e) {
    el('log-body').innerHTML = `<div class="log-empty" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
    return;
  }
  logCache = log;

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
        <th>Date</th><th>Customer</th><th>Type</th><th>Amount Paid</th><th>Document</th><th>Emailed</th><th>Realtor</th>
      </tr></thead>
      <tbody>${log.map((e) => `
        <tr class="log-row" onclick="openTxDetail('${e.id}')" tabindex="0" title="Click to view full details">
          <td style="white-space:nowrap;color:var(--muted)">${new Date(e.timestamp).toLocaleDateString('en-NG')}</td>
          <td><div style="font-weight:500">${escapeHtml(e.custName)}</div>${e.custCreated ? '<div style="font-size:10px;color:var(--gold)">New</div>' : ''}</td>
          <td><span class="tx-badge tx-${e.txType}">${txLabels[e.txType] || e.txType}</span></td>
          <td style="font-family:'DM Mono',monospace;font-size:12px">${fmt(e.amtPaid)}</td>
          <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--gold)">${escapeHtml(e.docNumber || e.paymentId || '—')}${e.soNumber ? '<br><span style="color:var(--muted)">SO: ' + escapeHtml(e.soNumber) + '</span>' : ''}</td>
          <td>${e.emailSent ? '<span style="color:var(--green)">✓ Sent</span>' : '<span style="color:var(--red)" title="' + escapeHtml((e.emailErrors || []).join(' · ')) + '">✗ Failed</span>'}</td>
          <td style="color:var(--muted)">${escapeHtml(e.realtor || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── TRANSACTION DETAIL MODAL ──
function openTxDetail(transactionId) {
  const tx = logCache.find((t) => t.id === transactionId);
  if (!tx) return;

  const txLabels = { topup: 'Top-up', outright: 'Outright Purchase', installment: 'New Installment' };
  const docLabels = { invoice: 'Invoice', sales_order: 'Sales Order', receipt_only: 'Receipt Only' };
  const canResend = tx.docType === 'invoice' || tx.docType === 'sales_order';

  const row = (label, value) => value
    ? `<div class="detail-row"><div class="detail-label">${escapeHtml(label)}</div><div class="detail-value">${value}</div></div>`
    : '';

  el('tx-detail-body').innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-title">${escapeHtml(tx.custName)}</div>
        <div class="detail-sub">${txLabels[tx.txType] || tx.txType} · ${new Date(tx.timestamp).toLocaleString('en-NG')}</div>
      </div>
      <span class="tx-badge tx-${tx.txType}">${txLabels[tx.txType] || tx.txType}</span>
    </div>
    ${row('Customer Email', tx.custEmail ? escapeHtml(tx.custEmail) : '<span style="color:var(--muted)">No email on file</span>')}
    ${row('Property / Item', escapeHtml(tx.propDesc || '—') + (tx.plotSize ? ' · ' + escapeHtml(tx.plotSize) : ''))}
    ${row('Amount Paid', fmt(tx.amtPaid))}
    ${tx.fullPrice ? row('Full Price', fmt(tx.fullPrice)) : ''}
    ${row('Payment Mode', modeLabel(tx.payMode) + (tx.bankAccountName ? ' · ' + escapeHtml(tx.bankAccountName) : ''))}
    ${row('Payment Reference', tx.payRef ? escapeHtml(tx.payRef) : '')}
    ${row('Document', (docLabels[tx.docType] || tx.docType) + ': ' + escapeHtml(tx.docNumber || tx.paymentId || '—'))}
    ${tx.soNumber ? row('Linked Sales Order', escapeHtml(tx.soNumber)) : ''}
    ${row('Contract Code', tx.contractCode ? `<span style="font-family:'DM Mono',monospace">${escapeHtml(tx.contractCode)}</span>` : '<span style="color:var(--muted)">Not generated</span>')}
    ${row('Realtor', escapeHtml(tx.realtor || '—') + (tx.realtorEmail ? ' · ' + escapeHtml(tx.realtorEmail) : ''))}
    ${row('Customer Emailed', tx.emailSent
      ? '<span style="color:var(--green)">✓ Sent</span>'
      : '<span style="color:var(--red)">✗ Failed' + ((tx.emailErrors || []).length ? ' — ' + escapeHtml(tx.emailErrors.join(' · ')) : '') + '</span>')}
    ${row('New Customer', tx.custCreated ? '<span style="color:var(--gold)">Yes — created during this transaction</span>' : '')}

    <div id="tx-detail-resend-area" style="margin-top:1.25rem">
      ${canResend
        ? `<button class="log-btn gold" id="tx-detail-resend-btn" onclick="resendContractFromModal('${tx.id}')" style="width:100%;justify-content:center;display:flex;align-items:center;gap:6px">Resend Contract &amp; Document</button>`
        : '<div style="font-size:12px;color:var(--muted);text-align:center">Top-ups don\u2019t carry their own contract — see the original installment/outright transaction.</div>'
      }
    </div>
  `;
  el('tx-detail-modal').classList.remove('hidden');
}

function closeTxDetail() {
  el('tx-detail-modal').classList.add('hidden');
}

async function resendContractFromModal(transactionId) {
  const btn = el('tx-detail-resend-btn');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Resending...';
  try {
    const result = await api('/api/contracts/resend', { method: 'POST', body: JSON.stringify({ transactionId }) });
    btn.innerHTML = `✓ Resent to ${escapeHtml(result.custEmail || '')}`;
    setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 3500);
  } catch (e) {
    alert(`Could not resend contract: ${e.message}`);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
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
  const headers = ['Timestamp', 'Realtor', 'Customer', 'Customer ID', 'Customer Email', 'New Customer', 'Tx Type', 'Property', 'Amount Paid', 'Full Price', 'Payment Mode', 'Bank Account', 'Reference', 'Document Type', 'Document Number', 'Payment ID', 'SO Number', 'Emailed'];
  const rows = log.map((e) => [
    new Date(e.timestamp).toLocaleString('en-NG'),
    e.realtor, e.custName, e.custId, e.custEmail || '', e.custCreated ? 'Yes' : 'No',
    e.txType, e.propDesc || '', e.amtPaid, e.fullPrice || '',
    modeLabel(e.payMode), e.bankAccountName || '', e.payRef || '', e.docType || '',
    e.docNumber || '', e.paymentId || '', e.soNumber || '', e.emailSent ? 'Yes' : 'No'
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `landblaze_transactions_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── STAFF MANAGEMENT (admin only) ──
let staffCache = [];

async function renderStaff() {
  el('staff-body').innerHTML = '<div class="log-empty"><span class="spinner"></span>Loading...</div>';
  try {
    const users = await api('/api/staff');
    staffCache = users;
    if (!users.length) {
      el('staff-body').innerHTML = '<div class="log-empty">No staff accounts found.</div>';
      return;
    }
    const roleColors = { admin: 'tx-outright', manager: 'tx-installment', realtor: 'tx-topup' };
    el('staff-body').innerHTML = `
      <table class="log-table">
        <thead><tr>
          <th>Username</th><th>Display Name</th><th>Email</th><th>Role</th><th>Created</th><th></th>
        </tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td style="font-family:'DM Mono',monospace;font-size:12px">${escapeHtml(u.username)}</td>
            <td style="font-weight:500">${escapeHtml(u.displayName)}</td>
            <td style="color:var(--muted);font-size:12px">${escapeHtml(u.email || '—')}</td>
            <td><span class="tx-badge ${roleColors[u.role] || ''}">${escapeHtml(u.role)}</span></td>
            <td style="color:var(--muted);font-size:11px">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-NG') : '—'}</td>
            <td>
              <div style="display:flex;gap:6px;justify-content:flex-end">
                <button onclick="openEditUserForm('${escapeHtml(u.username)}')" style="background:transparent;border:0.5px solid var(--gold-border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--gold);cursor:pointer;font-family:'DM Sans',sans-serif">Edit</button>
                ${u.username !== currentUser.username
                  ? `<button onclick="deleteUser('${escapeHtml(u.username)}')" style="background:transparent;border:0.5px solid var(--red-border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--red);cursor:pointer;font-family:'DM Sans',sans-serif">Remove</button>`
                  : '<span style="font-size:11px;color:var(--muted);align-self:center">You</span>'
                }
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el('staff-body').innerHTML = `<div class="log-empty" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

let editingUsername = null; // null = create mode; set = edit mode

function showCreateUserForm() {
  editingUsername = null;
  el('create-user-card-title').textContent = 'New Staff Account';
  ['su-username', 'su-name', 'su-email', 'su-password'].forEach((id) => { el(id).value = ''; });
  el('su-username').disabled = false;
  el('su-password').placeholder = '••••••••';
  el('su-password-label').textContent = 'Password * (min 8 chars)';
  el('su-role').value = 'realtor';
  el('su-submit').textContent = 'Create Account';
  el('su-error').classList.add('hidden');
  el('create-user-card').classList.remove('hidden');
  el('su-username').focus();
}

function openEditUserForm(username) {
  const u = staffCache.find((x) => x.username === username);
  if (!u) return;
  editingUsername = u.username;
  el('create-user-card-title').textContent = `Edit ${u.displayName}`;
  el('su-username').value = u.username;
  el('su-username').disabled = true;
  el('su-name').value = u.displayName;
  el('su-email').value = u.email || '';
  el('su-password').value = '';
  el('su-password').placeholder = 'Leave blank to keep current password';
  el('su-password-label').textContent = 'New Password (optional, min 8 chars)';
  el('su-role').value = u.role;
  el('su-submit').textContent = 'Save Changes';
  el('su-error').classList.add('hidden');
  el('create-user-card').classList.remove('hidden');
  el('su-name').focus();
}

function hideCreateUserForm() {
  el('create-user-card').classList.add('hidden');
  el('su-username').disabled = false;
  editingUsername = null;
}

async function submitCreateUser() {
  const isEdit = Boolean(editingUsername);
  const username = el('su-username').value.trim();
  const displayName = el('su-name').value.trim();
  const email = el('su-email').value.trim();
  const password = el('su-password').value;
  const role = el('su-role').value;

  el('su-error').classList.add('hidden');

  if (isEdit) {
    if (!displayName || !email) {
      el('su-error').textContent = 'Display name and email are required.';
      el('su-error').classList.remove('hidden');
      return;
    }
  } else if (!username || !displayName || !email || !password) {
    el('su-error').textContent = 'All fields are required.';
    el('su-error').classList.remove('hidden');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    el('su-error').textContent = 'Please enter a valid email address.';
    el('su-error').classList.remove('hidden');
    return;
  }
  if (password && password.length < 8) {
    el('su-error').textContent = 'Password must be at least 8 characters.';
    el('su-error').classList.remove('hidden');
    return;
  }

  const btn = el('su-submit');
  btn.disabled = true; btn.textContent = isEdit ? 'Saving...' : 'Creating...';
  try {
    if (isEdit) {
      const body = { displayName, email, role };
      if (password) body.password = password;
      await api(`/api/staff?username=${encodeURIComponent(editingUsername)}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/staff', { method: 'POST', body: JSON.stringify({ username, displayName, email, password, role }) });
    }
    hideCreateUserForm();
    renderStaff();
  } catch (e) {
    el('su-error').textContent = e.message;
    el('su-error').classList.remove('hidden');
  }
  btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Create Account';
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
