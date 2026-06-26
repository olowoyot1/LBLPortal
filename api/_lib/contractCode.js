// api/_lib/contractCode.js
// Generates a short, sequential, app-owned reference code for each contract
// — independent of Zoho's invoice/sales-order numbering — for internal
// tracking/branding purposes (e.g. on physical files, customer support
// lookups). Format: LBL-<YEAR>-<4-digit sequence>, e.g. LBL-2026-0001.
import { nextContractSequence } from './db.js';

export async function generateContractCode(date) {
  const year = (date ? new Date(date) : new Date()).getFullYear();
  const seq = await nextContractSequence();
  return `LBL-${year}-${String(seq).padStart(4, '0')}`;
}
