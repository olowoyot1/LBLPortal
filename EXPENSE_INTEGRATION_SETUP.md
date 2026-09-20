# LBLPortal Expense Posting Setup

## Flow

`LBLPortal -> Zoho Expense -> Zoho Expense Approval -> Zoho Books`

The portal creates the Zoho Expense and report and submits the report into Zoho Expense. The portal does **not** create a duplicate Books expense. Zoho Expense/Books native integration should move approved expenses into Books. The portal's 10-minute reconciliation job checks the approved report and matches the resulting Books expense by the portal reference number.

## Environment variables

Keep the existing Zoho Books variables and add/verify:

```text
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
ZOHO_ORG_ID=...
ZOHO_EXPENSE_ORG_ID=...   # optional when identical to ZOHO_ORG_ID
ZOHO_EXPENSE_API_BASE=https://www.zohoapis.com/expense/v1
CRON_SECRET=...
```

If `ZOHO_EXPENSE_ORG_ID` is omitted, the integration uses `ZOHO_ORG_ID`.

## OAuth scopes

The Zoho OAuth refresh token must have the Expense permissions required by the endpoints used here, including: `ZohoExpense.expense.CREATE`, `ZohoExpense.expense.READ`, `ZohoExpense.expensereport.CREATE`, `ZohoExpense.expensereport.READ`, `ZohoExpense.expensecategory.READ`, and `ZohoExpense.currency.READ`. Existing Zoho Books scopes must remain present. If the current refresh token was created without these scopes, authorize the Zoho client again and replace `ZOHO_REFRESH_TOKEN`.

## Zoho Expense configuration

In Zoho Expense, confirm that the organization is integrated with Zoho Books and that the approval workflow is configured. Approved reports should be synchronized through the native Books integration.

## Test

1. Deploy with the environment variables above.
2. Log in to LBLPortal and open **Expenses**.
3. Create a small test expense.
4. Confirm the expense and report exist in Zoho Expense and the report is submitted.
5. Approve the report in Zoho Expense using the normal approver account.
6. Allow the native Zoho Expense -> Books sync to complete.
7. The scheduled portal reconciliation runs every 10 minutes and should change the portal record to **synced to books** once it finds the matching Books expense.
8. The **Refresh** button can be used to reconcile immediately.

## Important

A report being merely `submitted` in Zoho Expense is not treated as posted to Books by this code. The portal waits for the report to become `approved`, then reconciles the Books record. This avoids treating an unapproved expense as an accounting posting.
