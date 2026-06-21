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
  const payload = {
    contact_name: name,
    contact_type: 'customer',
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { billing_address: { address } } : {}),
  };
  const data = await zohoRequest('post', '/contacts', { data: payload });
  if (!data.contact?.contact_id) {
    throw new Error(`Contact creation did not return a contact_id: ${JSON.stringify(data)}`);
  }
  return { customer_id: data.contact.contact_id, customer_name: data.contact.contact_name };
}

// ── Sales orders ──

export async function listOpenSalesOrders(customerId) {
  const data = await zohoRequest('get', '/salesorders', {
    params: { customer_id: customerId, status: 'open' },
  });
  return (data.salesorders || []).map((o) => ({
    salesorder_id: o.salesorder_id,
    salesorder_number: o.salesorder_number,
    total: o.total,
    balance_due: o.balance ?? o.total,
    status: o.status,
    date: o.date,
    subject: o.reference_number || o.salesorder_number,
  }));
}

export async function createSalesOrder({ customerId, date, lineItemName, rate, notes, salesperson }) {
  const payload = {
    customer_id: customerId,
    date,
    line_items: [{ name: lineItemName, rate, quantity: 1 }],
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

// ── Invoices ──

export async function createInvoice({ customerId, date, lineItemName, rate, notes, salesperson }) {
  const payload = {
    customer_id: customerId,
    date,
    line_items: [{ name: lineItemName, rate, quantity: 1 }],
    notes,
    ...(salesperson ? { salesperson_name: salesperson } : {}),
  };
  const data = await zohoRequest('post', '/invoices', { data: payload });
  if (!data.invoice?.invoice_id) {
    throw new Error(`Invoice creation did not return an invoice_id: ${JSON.stringify(data)}`);
  }
  return { invoice_id: data.invoice.invoice_id, invoice_number: data.invoice.invoice_number };
}

// ── Customer payments ──

export async function createCustomerPayment({ customerId, amount, paymentMode, date, referenceNumber, description }) {
  const payload = {
    customer_id: customerId,
    payment_mode: paymentMode,
    amount,
    date,
    ...(referenceNumber ? { reference_number: referenceNumber } : {}),
    description,
  };
  const data = await zohoRequest('post', '/customerpayments', { data: payload });
  if (!data.payment?.payment_id) {
    throw new Error(`Payment creation did not return a payment_id: ${JSON.stringify(data)}`);
  }
  return { payment_id: data.payment.payment_id, payment_number: data.payment.payment_number };
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
