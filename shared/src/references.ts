// FIX-2 (docs/decisions.md D-fix-2): the bank-transfer reference typed at the counter. One normalization, used by
// the server (validation, storage, duplicate detection) and by the POS (what the cashier sees before sending):
//   Arabic-Indic (٠–٩) and Persian (۰–۹) digits → ASCII; trimmed; runs of spaces → one space; upper case.
// Valid: 4–40 characters of A–Z, 0–9, space, "-", "/" and ".". Stored normalized, so equal references compare equal.

export const BANK_REFERENCE_MIN = 4;
export const BANK_REFERENCE_MAX = 40;
export const BANK_REFERENCE_PATTERN = /^[A-Z0-9 ./-]+$/;

export function normalizeBankReference(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** The normalized reference, or null when it is not a valid bank-transfer reference. */
export function validBankReference(raw: string | null | undefined): string | null {
  const v = normalizeBankReference(raw ?? '');
  return v.length >= BANK_REFERENCE_MIN && v.length <= BANK_REFERENCE_MAX && BANK_REFERENCE_PATTERN.test(v) ? v : null;
}
