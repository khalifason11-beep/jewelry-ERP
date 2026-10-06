// Names entered by people (item types, products, suppliers; CAT-0, docs/decisions.md D-cat0-*).
//
// normalizeName() mirrors the database function jerp_normalize_name (migration 0015), which is the
// authority: generated columns with unique indexes refuse a second spelling of the same name. The
// TypeScript copy lets the UI and the services find the existing row first; a property test proves
// both give the same result.
//
// Rule: Unicode NFKC; remove zero-width characters (ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM), tatweel and
// Arabic diacritics (U+064B–U+065F, U+0670); أ إ آ ٱ → ا and ى → ي (ة and ه stay distinct, owner
// decision); Arabic-Indic and Eastern Arabic-Indic digits → 0-9; Latin A-Z → a-z (ASCII only, like the
// SQL, whose lower() would depend on the collation); whitespace collapsed and trimmed.

// Built from code points so the source holds no invisible characters.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const range = (from: number, to: number) => cp(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
// ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM, tatweel, Arabic diacritics U+064B–U+065F and the superscript alef U+0670.
const REMOVED = new RegExp(`[${cp(0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x0640)}${range(0x064b, 0x065f)}${cp(0x0670)}]`, 'g');
// أ إ آ ٱ ى, Arabic-Indic and Eastern Arabic-Indic digits, Latin capitals.
const FROM = cp(0x0623, 0x0625, 0x0622, 0x0671, 0x0649) + range(0x0660, 0x0669) + range(0x06f0, 0x06f9) + range(0x41, 0x5a);
const TO = cp(0x0627, 0x0627, 0x0627, 0x0627, 0x064a) + '0123456789' + '0123456789' + range(0x61, 0x7a);
const MAP = new Map([...FROM].map((c, i) => [c, TO[i]]));

export function normalizeName(s: string | null | undefined): string {
  const stripped = (s ?? '').normalize('NFKC').replace(REMOVED, '');
  const translated = [...stripped].map((c) => MAP.get(c) ?? c).join('');
  // Same whitespace set as the SQL (ASCII only; NFKC already turned other spaces into U+0020), and
  // only U+0020 is trimmed, like PostgreSQL's btrim().
  return translated.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ +| +$/g, '');
}

/** Clean what a person typed before storing it (the stored name keeps their spelling, minus noise). */
export function cleanName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFC').replace(new RegExp(`[${cp(0x200b, 0x200e, 0x200f, 0xfeff)}]`, 'g'), '').replace(/\s+/g, ' ').trim();
}

/** The name to show: English in the English UI when it exists, otherwise the Arabic one (CAT-0, A2). */
export function displayName(lang: 'ar' | 'en', name: string | null | undefined, nameAr: string | null | undefined): string {
  const en = (name ?? '').trim();
  const ar = (nameAr ?? '').trim();
  if (lang === 'en') return en || ar;
  return ar || en;
}
