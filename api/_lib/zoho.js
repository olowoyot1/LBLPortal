// api/_lib/zoho.js
import axios from 'axios';
import { getZohoToken, saveZohoToken } from './db.js';

const ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com';
const API_BASE = process.env.ZOHO_API_BASE || 'https://www.zohoapis.com/books/v3';
const ORG_ID = process.env.ZOHO_ORG_ID;

function assertConfigured() {
  const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Zoho Books is not configured. Missing env vars: ${missing.join(', ')}. ` +
      `Add these in your Vercel project settings → Environment Variables.`
    );
  }
}

async function getAccessToken() {
  assertConfigured();
  const cached = await getZohoToken();
  const now = Date.now();

  if (cached.accessToken && cached.expiresAt && now < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const resp = await axios.post(`${ACCOUNTS_BASE}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });

  if (!resp.data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(resp.data)}`);
  }

  const expiresAt = now + (resp.data.expires_in || 3600) * 1000;
  await saveZohoToken({ accessToken: resp.data.access_token, expiresAt });
  return resp.data.access_token;
}

async function zohoRequest(method, endpoint, { params = {}, data = null } = {}) {
  const token = await getAccessToken();
  try {
    const resp = await axios({
      method,
      url: `${API_BASE}${endpoint}`,
      params: { organization_id: ORG_ID, ...params },
      data,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return resp.data;
  } catch (err) {
    const zohoMsg = err.response?.data?.message;
    throw new Error(`Zoho API error [${endpoint}]: ${zohoMsg || err.message}`);
  }
}

// ── Items ──

export async function searchItems(name) {
  const data = await zohoRequest('get', '/items', {
    params: { name_contains: name, filter_by: 'Status.Active', per_page: 10 },
  });
  return (data.items || []).map((i) => ({
    item_id: i.item_id,
    name: i.name,
    rate: i.rate,
    description: i.description || '',
    unit: i.unit || '',
  }));
}

export async function listItems() {
  const data = await zohoRequest('get', '/items', { params: { per_page: 50, filter_by: 'Status.Active' } });
  return (data.items || []).map((i) => ({
    item_id: i.item_id,
    name: i.name,
    rate: i.rate,
    description: i.description || '',
    unit: i.unit || '',
  }));
}

// ── Bank accounts ──

export async function listBankAccounts() {
  const data = await zohoRequest('get', '/bankaccounts', { params: { filter_by: 'Status.Active' } });
  return (data.bankaccounts || []).map((b) => ({
    account_id: b.account_id,
    account_name: b.account_name,
    bank_name: b.bank_name || '',
    account_type: b.account_type || '',
    account_number: b.account_number || '',
  }));
}

// ── Contacts ──

export async function searchContacts(name) {
  const data = await zohoRequest('get', '/contacts', {
    params: { contact_name_contains: name, contact_type: 'customer', per_page: 6 },
  });
  return (data.contacts || []).map((c) => ({
    customer_id: c.contact_id,
    customer_name: c.contact_name,
    email: c.email,
    phone: c.phone,
  }));
}

export async function createContact({ name, email, phone, address }) {
  // Email, phone, and address are mandatory for every new customer — Zoho
  // needs a valid email on file or the auto-email-on-create step later
  // (invoice/sales order/receipt) has nothing to send to.
  const missing = [];
  if (!name?.trim()) missing.push('name');
  if (!email?.trim()) missing.push('email');
  if (!phone?.trim()) missing.push('phone');
  if (!address?.trim()) missing.push('address');
  if (missing.length) {
    throw new Error(`Missing required customer field(s): ${missing.join(', ')}`);
  }

  // Zoho Books requires email AND phone to be set on a contact_person entry.
  // The top-level fields alone are not reliably picked up for email sending.
  // Zoho uses "mobile" (not "phone") inside contact_persons for the mobile
  // number — setting both "phone" and "mobile" ensures the number is saved
  // regardless of which field Zoho prefers for the org's plan/region.
  const payload = {
    contact_name: name,
    contact_type: 'customer',
    email,
    phone,
    mobile: phone,
    billing_address: { address },
    contact_persons: [
      {
        first_name: name,
        email,
        phone,
        mobile: phone,
        is_primary_contact: true,
      },
    ],
  };
  const data = await zohoRequest('post', '/contacts', { data: payload });
  if (!data.contact?.contact_id) {
    throw new Error(`Contact creation did not return a contact_id: ${JSON.stringify(data)}`);
  }
  return {
    customer_id: data.contact.contact_id,
    customer_name: data.contact.contact_name,
    // Fall back to input email if Zoho does not echo it back
    email: data.contact.email || email,
    phone: data.contact.phone || phone,
  };
}

// ── Sales orders ──

function extractEmailTemplate(resp, fallbackSubject) {
  // Zoho's GET .../email response has been observed nesting the template
  // under different keys depending on doc type/version. Check the common
  // shapes before giving up and using a safe fallback, since the /email
  // POST endpoint rejects an empty/missing subject outright.
  const src = resp?.data || resp?.mail_content || resp || {};
  const subject = src.subject || src.mail_subject || src.custom_subject || fallbackSubject;
  const body = src.body || src.mail_body || src.custom_body || '';
  return { subject, body };
}

export async function listOpenSalesOrders(customerId) {
  const data = await zohoRequest('get', '/salesorders', {
    params: { customer_id: customerId, status: 'open' },
  });
  // NOTE: Zoho sales orders do not carry a real running "balance" field —
  // that only exists on invoices. We deliberately do NOT fall back to
  // o.balance ?? o.total here, since that previously masked a bug where
  // balance always equaled total. The real remaining balance is computed
  // in process.js from our own transaction log (sum of payments already
  // recorded against this sales order).
  return (data.salesorders || []).map((o) => ({
    salesorder_id: o.salesorder_id,
    salesorder_number: o.salesorder_number,
    total: o.total,
    status: o.status,
    date: o.date,
    subject: o.reference_number || o.salesorder_number,
  }));
}

export async function createSalesOrder({ customerId, date, itemId, lineItemName, rate, notes, salesperson }) {
  const lineItem = itemId
    ? { item_id: itemId, rate, quantity: 1 }
    : { name: lineItemName, rate, quantity: 1 };
  const payload = {
    customer_id: customerId,
    date,
    line_items: [lineItem],
    notes,
    ...(salesperson ? { salesperson_name: salesperson } : {}),
  };
  const data = await zohoRequest('post', '/salesorders', { data: payload });
  if (!data.salesorder?.salesorder_id) {
    throw new Error(`Sales order creation did not return a salesorder_id: ${JSON.stringify(data)}`);
  }
  return {
    salesorder_id: data.salesorder.salesorder_id,
    salesorder_number: data.salesorder.salesorder_number,
  };
}

export async function sendSalesOrderEmail(salesorderId, { email, salesorderNumber } = {}) {
  // Zoho's /email endpoint rejects calls where subject/body are omitted
  // ("Invalid value passed for Subject") — it does not silently fall back
  // to a template the way the field docs implied. The reliable approach is
  // to first GET the pre-filled email content Zoho would use, then POST
  // that same subject/body back, only overriding the recipient.
  const template = await zohoRequest('get', `/salesorders/${salesorderId}/email`);
  const { subject, body } = extractEmailTemplate(
    template,
    `Sales Order ${salesorderNumber || salesorderId}`
  );
  const payload = { subject, body };
  if (email) payload.to_mail_ids = [email];
  await zohoRequest('post', `/salesorders/${salesorderId}/email`, { data: payload });
}

export async function markSalesOrderOpen(salesorderId) {
  // Sales orders in Zoho Books use Draft / Open / Void / Closed — there is
  // no "sent" status for this document type. Emailing usually flips a
  // draft to Open automatically, but we also call this explicitly so the
  // order is guaranteed to leave Draft even if the email step is skipped
  // or fails (e.g. customer has no email on file).
  await zohoRequest('post', `/salesorders/${salesorderId}/status/open`);
}

// ── Invoices ──

export async function createInvoice({ customerId, date, itemId, lineItemName, rate, notes, salesperson }) {
  const lineItem = itemId
    ? { item_id: itemId, rate, quantity: 1 }
    : { name: lineItemName, rate, quantity: 1 };
  const payload = {
    customer_id: customerId,
    date,
    line_items: [lineItem],
    notes,
    ...(salesperson ? { salesperson_name: salesperson } : {}),
  };
  const data = await zohoRequest('post', '/invoices', { data: payload });
  if (!data.invoice?.invoice_id) {
    throw new Error(`Invoice creation did not return an invoice_id: ${JSON.stringify(data)}`);
  }
  return { invoice_id: data.invoice.invoice_id, invoice_number: data.invoice.invoice_number };
}

export async function sendInvoiceEmail(invoiceId, { email, invoiceNumber } = {}) {
  // Same fix as sales orders: GET the pre-filled email content first, then
  // POST it back rather than omitting subject/body and hoping for a
  // server-side default — Zoho's /email endpoint rejects an empty subject.
  const template = await zohoRequest('get', `/invoices/${invoiceId}/email`);
  const { subject, body } = extractEmailTemplate(
    template,
    `Invoice ${invoiceNumber || invoiceId}`
  );
  const payload = { subject, body };
  if (email) payload.to_mail_ids = [email];
  await zohoRequest('post', `/invoices/${invoiceId}/email`, { data: payload });
}

export async function markInvoiceSent(invoiceId) {
  // Emailing an invoice normally flips it from Draft to Sent automatically,
  // but we also call this explicitly so the invoice is guaranteed to leave
  // Draft status even if the email step is skipped or fails (e.g. customer
  // has no email on file).
  await zohoRequest('post', `/invoices/${invoiceId}/status/sent`);
}

// ── Customer payments ──

export async function createCustomerPayment({ customerId, amount, paymentMode, accountId, date, referenceNumber, description }) {
  const payload = {
    customer_id: customerId,
    payment_mode: paymentMode,
    amount,
    date,
    ...(accountId ? { account_id: accountId } : {}),
    ...(referenceNumber ? { reference_number: referenceNumber } : {}),
    description,
  };
  const data = await zohoRequest('post', '/customerpayments', { data: payload });
  if (!data.payment?.payment_id) {
    throw new Error(`Payment creation did not return a payment_id: ${JSON.stringify(data)}`);
  }
  return { payment_id: data.payment.payment_id, payment_number: data.payment.payment_number };
}

export async function sendPaymentReceiptEmail(paymentId, { email, paymentNumber } = {}) {
  // NOTE: Zoho Books' public v3 API documentation does not list a
  // dedicated "email a customer payment" endpoint the way it does for
  // invoices and sales orders. We use the same GET-then-POST pattern as
  // those (fetch the pre-filled subject/body, then send it back) since
  // the same "Invalid value passed for Subject" error showed up here too,
  // suggesting the endpoint does exist and follows the same contract. If
  // the GET 404s, that's a clean signal the endpoint genuinely isn't
  // available for this org/plan, and the caller will record it as a
  // non-blocking error without affecting the invoice/sales order email.
  const template = await zohoRequest('get', `/customerpayments/${paymentId}/email`);
  const { subject, body } = extractEmailTemplate(
    template,
    `Payment Receipt ${paymentNumber || paymentId}`
  );
  const payload = { subject, body };
  if (email) payload.to_mail_ids = [email];
  await zohoRequest('post', `/customerpayments/${paymentId}/email`, { data: payload });
}

// ── Verification ──

export async function verifyPaymentExists(paymentId) {
  const data = await zohoRequest('get', `/customerpayments/${paymentId}`);
  return Boolean(data.payment?.payment_id);
}

export async function verifyInvoiceExists(invoiceId) {
  const data = await zohoRequest('get', `/invoices/${invoiceId}`);
  return Boolean(data.invoice?.invoice_id);
}

export async function verifySalesOrderExists(salesorderId) {
  const data = await zohoRequest('get', `/salesorders/${salesorderId}`);
  return Boolean(data.salesorder?.salesorder_id);
}
