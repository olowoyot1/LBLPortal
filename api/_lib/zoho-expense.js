// Zoho Expense API integration for LBLPortal.
// Uses the same Zoho OAuth client/refresh token as Zoho Books, but sends the
// Expense-specific organization header required by Zoho Expense.
import axios from 'axios';
import { getZohoAccessToken } from './zoho.js';

const EXPENSE_BASE = process.env.ZOHO_EXPENSE_API_BASE || 'https://www.zohoapis.com/expense/v1';
const EXPENSE_ORG_ID = process.env.ZOHO_EXPENSE_ORG_ID || process.env.ZOHO_ORG_ID;

function assertConfigured() {
  const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']
    .filter((k) => !process.env[k]);
  if (!EXPENSE_ORG_ID) missing.push('ZOHO_EXPENSE_ORG_ID (or ZOHO_ORG_ID)');
  if (missing.length) {
    throw new Error(`Zoho Expense is not configured. Missing env vars: ${missing.join(', ')}.`);
  }
}

async function expenseRequest(method, endpoint, { params = {}, data = null } = {}) {
  assertConfigured();
  const token = await getZohoAccessToken();
  try {
    const resp = await axios({
      method,
      url: `${EXPENSE_BASE}${endpoint}`,
      params,
      data,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'X-com-zoho-expense-organizationid': EXPENSE_ORG_ID,
        'Content-Type': 'application/json',
      },
    });
    return resp.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Zoho Expense API error [${endpoint}]: ${msg}`);
  }
}

export async function listExpenseCategories() {
  const data = await expenseRequest('get', '/expensecategories', {
    params: { filter_by: 'Status.Active', per_page: 200 },
  });
  return (data.expense_categories || data.expense_accounts || [])
    .filter((c) => c.is_enabled !== false && String(c.status || 'active').toLowerCase() !== 'inactive')
    .map((c) => ({
      category_id: c.category_id,
      category_name: c.category_name,
      gl_code: c.gl_code || '',
      is_receipt_required: !!c.is_receipt_required,
      receipt_required_amount: c.receipt_required_amount,
    }));
}

export async function listExpenseCurrencies() {
  const data = await expenseRequest('get', '/settings/currencies', { params: { per_page: 200 } });
  return (data.currencies || []).map((c) => ({
    currency_id: c.currency_id,
    currency_code: c.currency_code,
    currency_name: c.currency_name,
    is_base_currency: !!c.is_base_currency,
  }));
}

export async function createExpense({ amount, currencyId, date, categoryId, description, referenceNumber, merchantName, paymentMode, customerId, projectId, isBillable = false, isReimbursable = true }) {
  const body = {
    currency_id: currencyId,
    date,
    is_reimbursable: !!isReimbursable,
    is_billable: !!isBillable,
    payment_mode: paymentMode || 'Cash',
    reference_number: referenceNumber,
    merchant_name: merchantName || undefined,
    customer_id: customerId || undefined,
    project_id: projectId || undefined,
    line_items: [{
      category_id: categoryId,
      amount: Number(amount),
      description: description || '',
    }],
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const data = await expenseRequest('post', '/expenses', { data: body });
  return data.expense || data;
}

export async function createExpenseReport({ reportName, description, startDate, endDate, expenseId, customerId, projectId }) {
  const body = {
    report_name: reportName,
    description: description || '',
    start_date: startDate,
    end_date: endDate || startDate,
    expenses: [{ expense_id: expenseId, order: 0 }],
  };
  if (customerId) body.customer_id = customerId;
  if (projectId) body.project_id = projectId;
  const data = await expenseRequest('post', '/expensereports', { data: body });
  return data.expense_report || data.report || data;
}

export async function getExpenseReport(reportId) {
  const data = await expenseRequest('get', `/expensereports/${reportId}`);
  return data.expense_report || data.report || data;
}

export async function submitExpenseReport(reportId) {
  const data = await expenseRequest('post', '/expensereports/submit', {
    data: { report_ids: String(reportId) },
  });
  return data;
}

export async function getExpense(expenseId) {
  const data = await expenseRequest('get', `/expenses/${expenseId}`);
  return data.expense || data;
}

export async function listExpenseReportsByStatus(status) {
  const data = await expenseRequest('get', '/expensereports', {
    params: { filter_by: status, per_page: 200 },
  });
  return data.expense_reports || data.reports || [];
}

export async function listExpenseReports() {
  const data = await expenseRequest('get', '/expensereports', { params: { per_page: 200 } });
  return data.expense_reports || data.reports || [];
}
