import { requireAuth } from '../_lib/auth.js';
import { getExpenses, saveExpenses, nextExpenseSequence } from '../_lib/db.js';
import { listExpenseCategories, listExpenseCurrencies, createExpense, createExpenseReport, submitExpenseReport, getExpenseReport } from '../_lib/zoho-expense.js';
import { searchBooksExpensesByReference } from '../_lib/zoho.js';

function today() { return new Date().toISOString().slice(0, 10); }
function clean(v) { return String(v ?? '').trim(); }
function canSeeAll(user) { return user.role === 'admin' || user.role === 'manager'; }
async function makeReference() { const n = await nextExpenseSequence(); return `LBL-EXP-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`; }
function visibleExpenses(expenses, user) { return canSeeAll(user) ? expenses : expenses.filter((e) => e.userId === user.userId || e.username === user.username); }

async function createPortalExpense(req, res, user) {
  const body = req.body || {};
  const amount = Number(body.amount);
  const date = clean(body.date) || today();
  const categoryId = clean(body.categoryId);
  const currencyId = clean(body.currencyId);
  const description = clean(body.description);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid expense amount.' });
  if (!categoryId) return res.status(400).json({ error: 'Select an expense category.' });
  if (!currencyId) return res.status(400).json({ error: 'Select a currency.' });
  if (!description) return res.status(400).json({ error: 'Enter an expense description.' });

  const expenses = await getExpenses();
  const reference = await makeReference();
  const now = new Date().toISOString();
  const record = {
    id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    reference, userId: user.userId, username: user.username, employeeName: user.displayName,
    expenseDate: date, categoryId, categoryName: clean(body.categoryName), amount,
    currencyId, currencyCode: clean(body.currencyCode) || 'NGN', merchantName: clean(body.merchantName),
    description, paymentMode: clean(body.paymentMode) || 'Cash', customerId: clean(body.customerId), projectId: clean(body.projectId),
    isBillable: !!body.isBillable, isReimbursable: body.isReimbursable !== false,
    status: 'creating_in_zoho_expense', zohoExpenseId: null, zohoReportId: null, zohoReportNumber: null,
    zohoExpenseStatus: null, booksExpenseId: null, booksSyncStatus: 'pending', lastSyncError: null,
    syncAttempts: 0, createdAt: now, updatedAt: now,
  };
  expenses.push(record); await saveExpenses(expenses);

  try {
    const zExpense = await createExpense({ amount, currencyId, date, categoryId, description, referenceNumber: reference,
      merchantName: record.merchantName, paymentMode: record.paymentMode, customerId: record.customerId, projectId: record.projectId,
      isBillable: record.isBillable, isReimbursable: record.isReimbursable });
    record.zohoExpenseId = String(zExpense.expense_id || zExpense.id || '');
    record.zohoExpenseStatus = zExpense.status || 'draft';
    record.status = 'creating_zoho_expense_report'; record.updatedAt = new Date().toISOString(); await saveExpenses(expenses);

    const zReport = await createExpenseReport({ reportName: `${reference} - ${record.employeeName}`, description,
      startDate: date, endDate: date, expenseId: record.zohoExpenseId, customerId: record.customerId, projectId: record.projectId });
    record.zohoReportId = String(zReport.expense_report_id || zReport.report_id || zReport.id || '');
    record.zohoReportNumber = zReport.report_number || zReport.report_number_display || null;
    record.status = 'submitting_to_zoho_expense'; record.updatedAt = new Date().toISOString(); await saveExpenses(expenses);

    if (record.zohoReportId) {
      await submitExpenseReport(record.zohoReportId);
      record.status = 'submitted_to_zoho_expense'; record.zohoExpenseStatus = 'submitted';
    }
    record.updatedAt = new Date().toISOString(); await saveExpenses(expenses);
    return res.status(201).json({ expense: record });
  } catch (err) {
    record.status = 'zoho_expense_failed'; record.lastSyncError = err.message; record.updatedAt = new Date().toISOString(); await saveExpenses(expenses);
    return res.status(502).json({ error: err.message, expense: record });
  }
}

async function refreshOne(record) {
  const updates = { ...record, updatedAt: new Date().toISOString(), syncAttempts: Number(record.syncAttempts || 0) + 1 };
  if (!updates.zohoReportId) return updates;
  try {
    const report = await getExpenseReport(updates.zohoReportId);
    const status = String(report.status || report.report_status || '').toLowerCase();
    if (status) updates.zohoExpenseStatus = status;
    if (status === 'approved') {
      updates.status = 'zoho_expense_approved';
      try {
        const matches = await searchBooksExpensesByReference(updates.reference);
        if (matches.length) {
          updates.booksExpenseId = String(matches[0].expense_id); updates.booksSyncStatus = 'synced_to_books';
          updates.status = 'synced_to_books'; updates.syncedAt = new Date().toISOString(); updates.lastSyncError = null;
        } else { updates.booksSyncStatus = 'pending'; updates.status = 'awaiting_books_sync'; }
      } catch (err) { updates.booksSyncStatus = 'pending'; updates.status = 'books_sync_check_failed'; updates.lastSyncError = err.message; }
    } else if (status === 'rejected') updates.status = 'zoho_expense_rejected';
    else if (status === 'submitted') updates.status = 'submitted_to_zoho_expense';
  } catch (err) { updates.lastSyncError = err.message; }
  return updates;
}

export default async function handler(req, res) {
  const action = clean(req.query?.action);
  const cronAuth = clean(req.headers?.authorization);
  const isCron = action === 'sync' && process.env.CRON_SECRET && cronAuth === `Bearer ${process.env.CRON_SECRET}`;
  const user = isCron ? { userId: 'system', username: 'system', role: 'admin', displayName: 'System Sync' } : await requireAuth(req);
  if (!user) return;
  try {
    if (req.method === 'GET') {
      if (action === 'categories') return res.json({ categories: await listExpenseCategories() });
      if (action === 'currencies') return res.json({ currencies: await listExpenseCurrencies() });
      if (action === 'sync') {
        const all = await getExpenses(); const candidates = visibleExpenses(all, user).filter((e) => e.zohoReportId && e.status !== 'synced_to_books');
        const updated = []; for (const e of candidates.slice(0, 50)) updated.push(await refreshOne(e));
        const map = new Map(updated.map((e) => [e.id, e])); const merged = all.map((e) => map.get(e.id) || e); await saveExpenses(merged);
        return res.json({ expenses: visibleExpenses(merged, user), synced: updated.length });
      }
      return res.json({ expenses: visibleExpenses(await getExpenses(), user) });
    }
    if (req.method === 'POST') {
      if (action === 'sync') {
        const all = await getExpenses(); const candidates = visibleExpenses(all, user).filter((e) => e.zohoReportId && e.status !== 'synced_to_books');
        const updated = []; for (const e of candidates.slice(0, 50)) updated.push(await refreshOne(e));
        const map = new Map(updated.map((e) => [e.id, e])); const merged = all.map((e) => map.get(e.id) || e); await saveExpenses(merged);
        return res.json({ expenses: visibleExpenses(merged, user), synced: updated.length });
      }
      return await createPortalExpense(req, res, user);
    }
    if (req.method === 'PUT') {
      const id = clean(req.query?.id); if (!id) return res.status(400).json({ error: 'Expense ID is required.' });
      const all = await getExpenses(); const idx = all.findIndex((e) => e.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Expense not found.' });
      if (!canSeeAll(user) && all[idx].userId !== user.userId) return res.status(403).json({ error: 'Not authorized.' });
      all[idx] = await refreshOne(all[idx]); await saveExpenses(all); return res.json({ expense: all[idx] });
    }
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) { console.error('Expenses API error:', err); return res.status(500).json({ error: err.message || 'Expense request failed.' }); }
}
