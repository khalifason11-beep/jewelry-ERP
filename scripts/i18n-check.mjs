#!/usr/bin/env node
// i18n audit for the jewelry ERP.
//
//   node scripts/i18n-check.mjs            report
//   node scripts/i18n-check.mjs --strict   exit 1 if anything is missing (for CI)
//
// 1. Hardcoded English in the UI: JSX text and user-facing string props/fields in
//    frontend/src that are not wrapped in t()/translate().
// 2. Missing Arabic: every key passed to t()/translate() in the frontend, plus every
//    user-facing key produced by the backend (error messages, report titles/columns/notes,
//    notifications, Hasad errors, audit-log description keys, ledger note templates) must
//    exist in frontend/src/lib/i18n-ar.ts.
// 3. Backend English sentences that bypass the key system: template-literal `description:`
//    values (audit text must use `key` + `params`) and English free text in seed data.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

const strict = process.argv.includes('--strict');
const FRONTEND = path.join(root, 'frontend/src');

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

// ───────── Arabic dictionary ─────────
const arSource = fs.readFileSync(path.join(FRONTEND, 'lib/i18n-ar.ts'), 'utf8');
const arFile = ts.createSourceFile('i18n-ar.ts', arSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const AR = new Map();
arFile.forEachChild(function visit(n) {
  if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) && ts.isStringLiteralLike(n.initializer)) {
    AR.set(n.name.text, n.initializer.text);
  }
  n.forEachChild(visit);
});

// Props / object fields whose string values are shown to users.
const UI_PROPS = new Set([
  'placeholder', 'title', 'aria-label', 'label', 'subtitle', 'header', 'emptyTitle', 'emptyBody',
  'body', 'confirmLabel', 'alt', 'hint', 'defaultReason', 'searchPlaceholder', 'desc', 'sub',
]);
const looksEnglish = (s) => /[A-Za-z]{2,}/.test(s) && !/^[A-Z0-9_./:-]+$/.test(s.trim()) && !/^(https?:|\/|#|[\w.-]+\.(png|svg|css))/.test(s.trim());
const T_FUNCS = new Set(['t', 'translate', 'tk']);
// Local helpers that forward their argument to a toast (e.g. `const done = (msg) => toast.success(msg)`).
const TOAST_HELPERS = /^(done|notify|onDone|showToast|toast\w*|flash)$/;
// Language self-names are intentionally shown in their own script by the switcher.
const ALLOW = new Set(['English', 'Loai Tabeede']);
/** Prose, not CSS classes / identifiers: has a capital letter, or several plain lowercase words. */
function isProse(text) {
  const s = text.trim();
  if (ALLOW.has(s) || !looksEnglish(s)) return false;
  const tokens = s.split(/\s+/);
  const TW = /^(!?[a-z]+:)*-?(bg|text|border|ring|px|py|pt|pb|ps|pe|p|m|mx|my|mt|mb|ms|me|w|h|min|max|flex|grid|font|rounded|size|gap|shadow|opacity|line|tracking|leading|items|justify|place|col|row|divide|space|accent|fill|stroke|inset|top|bottom|start|end|z|overflow|truncate|whitespace|num|scroll|sticky|absolute|relative|hidden|block|inline|uppercase|underline|cursor|transition|select)(-|$)/;
  if (tokens.some((tok) => TW.test(tok))) return false;
  return /[A-Z]/.test(s) || tokens.length >= 2;
}

const hardcoded = [];
const usedKeys = new Map(); // key -> first location

function insideTCall(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && T_FUNCS.has(p.expression.text)) return true;
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

for (const file of walk(FRONTEND, ['.tsx', '.ts'])) {
  if (file.endsWith('i18n-ar.ts')) continue;
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const loc = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const report = (n, text) => hardcoded.push({ where: loc(n), text: text.trim().replace(/\s+/g, ' ').slice(0, 90) });

  (function visit(n) {
    // Keys used with t('...') / translate('...')
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && T_FUNCS.has(n.expression.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const k = n.arguments[0].text;
      if (!usedKeys.has(k)) usedKeys.set(k, loc(n));
    }
    // JSX text
    if (ts.isJsxText(n) && looksEnglish(n.text)) report(n, n.text);
    // <X prop="English">
    if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && UI_PROPS.has(n.name.getText()) && looksEnglish(n.initializer.text)) {
      report(n, `${n.name.getText()}="${n.initializer.text}"`);
    }
    // { header: 'English' } / {label: `English`} outside t()
    if (ts.isPropertyAssignment(n) && UI_PROPS.has(n.name.getText().replace(/['"]/g, ''))) {
      const v = n.initializer;
      if ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && looksEnglish(v.text) && !insideTCall(v)) report(n, `${n.name.getText()}: '${v.text}'`);
    }
    // cond ? 'English' : 'Other' / x ?? 'English' anywhere inside JSX expressions or toast calls
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !insideTCall(n)) {
      const p = n.parent;
      const branch = (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) ||
        (ts.isBinaryExpression(p) && p.right === n && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind));
      let inJsx = false;
      for (let a = p; a; a = a.parent) {
        if (ts.isJsxExpression(a) || (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) && ['success', 'error', 'info', 'fromError'].includes(a.expression.name.text))) { inJsx = true; break; }
        if (ts.isFunctionLike(a) || ts.isVariableDeclaration(a)) break;
      }
      const text = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((x) => x.literal.text).join(' ') : n.text;
      if (branch && inJsx && isProse(text)) report(n, n.getText());
    }
    // toast.success('English'), toast.info(`English ${x}`), done('English'), notify('English')…
    const isToastCall = ts.isCallExpression(n) && (
      (ts.isPropertyAccessExpression(n.expression) && ['success', 'error', 'info', 'fromError', 'push'].includes(n.expression.name.text)) ||
      (ts.isIdentifier(n.expression) && TOAST_HELPERS.test(n.expression.text)));
    if (isToastCall) {
      for (const a of n.arguments) {
        if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && looksEnglish(a.text)) report(a, `toast: ${a.text}`);
        if (ts.isTemplateExpression(a) && looksEnglish(a.head.text + a.templateSpans.map((s) => s.literal.text).join(''))) report(a, `toast: ${a.getText()}`);
      }
    }
    // {'English'} or {`English ${x}`} as a JSX child
    if (ts.isJsxExpression(n) && n.expression && ts.isJsxElement(n.parent)) {
      const e = n.expression;
      if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && looksEnglish(e.text)) report(n, e.text);
      if (ts.isTemplateExpression(e) && looksEnglish(e.head.text + e.templateSpans.map((s) => s.literal.text).join(''))) report(n, e.getText());
    }
    n.forEachChild(visit);
  })(sf);
}

// ───────── backend keys that reach the UI ─────────
const backendKeys = new Map();
const addKey = (k, where) => k && !backendKeys.has(k) && backendKeys.set(k, where);
const BACKEND_DIRS = [path.join(root, 'backend/src'), path.join(root, 'integrations/hasad/src')];
const patterns = [
  /\b(?:badRequest|forbidden|conflict|unauthorized)\(\s*'((?:[^'\\]|\\.)+)'/g,
  /\bnew AppError\(\s*\d+,\s*'[A-Z_]+',\s*'((?:[^'\\]|\\.)+)'/g,
  /\bnew HasadError\(\s*'[A-Z_]+',\s*'((?:[^'\\]|\\.)+)'/g,
];
for (const file of BACKEND_DIRS.flatMap((d) => walk(d, ['.ts']))) {
  if (file.includes('/seed/') || file.endsWith('.test.ts')) continue;
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  for (const re of patterns) for (const m of src.matchAll(re)) addKey(m[1].replace(/\\'/g, "'"), rel);
  for (const m of src.matchAll(/\bnotFound\(\s*'([^']+)'\s*\)/g)) addKey(`${m[1]} not found`, rel);
  if (/\bnotFound\(\s*\)/.test(src)) addKey('Resource not found', rel);
  if (rel.endsWith('reports/service.ts')) {
    for (const m of src.matchAll(/\bc\(\s*'[^']+',\s*'([^']+)'/g)) addKey(m[1], rel);
    for (const m of src.matchAll(/\b(?:title|description):\s*'((?:[^'\\]|\\.)+)'/g)) addKey(m[1].replace(/\\'/g, "'"), rel);
    for (const m of src.matchAll(/notes:\s*\[([^\]]+)\]/g)) for (const n of m[1].matchAll(/'((?:[^'\\]|\\.)+)'/g)) addKey(n[1].replace(/\\'/g, "'"), rel);
  }
  if (rel.endsWith('notifications/service.ts')) for (const m of src.matchAll(/\b(?:title|body):\s*'([^']+)'/g)) addKey(m[1], rel);
  if (rel.endsWith('hasad/sync.ts')) for (const m of src.matchAll(/'(Hasad Gold[^']*)'/g)) addKey(m[1], rel);
}
for (const k of ['Authentication required', 'You do not have permission to perform this action', 'Unexpected server error', 'Unknown API endpoint']) addKey(k, 'backend defaults');

// Audit keys (`key:` in writeAudit entries, incl. both branches of a conditional), nested
// `ap.phrase('…')` keys, and English template-literal `description:` values (not allowed: audit
// text must be key + params so it can be translated).
// Ledger/status note templates rendered by frontend/src/lib/audit.ts (noteText).
const auditLib = fs.readFileSync(path.join(FRONTEND, 'lib/audit.ts'), 'utf8');
const noteTemplates = [...auditLib.matchAll(/\/,\s*'([^']+)',\s*\[/g)].map((m) => m[1]);
for (const k of noteTemplates) addKey(k, 'frontend/src/lib/audit.ts');
// Validation field labels shown in 'Invalid value for {field}' (frontend/src/lib/api.ts FIELD_LABELS).
const apiLib = fs.readFileSync(path.join(FRONTEND, 'lib/api.ts'), 'utf8');
const fieldBlock = apiLib.match(/FIELD_LABELS[^{]*\{([\s\S]*?)\n\};/);
if (fieldBlock) for (const m of fieldBlock[1].matchAll(/:\s*'([^']+)'/g)) addKey(m[1], 'frontend/src/lib/api.ts (FIELD_LABELS)');
const NOTE_PREFIXES = noteTemplates.map((k) => k.split('{')[0]);
const backendTemplates = [];
const seedEnglish = [];
const litTexts = (e) => {
  if (!e) return [];
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isParenthesizedExpression(e)) return litTexts(e.expression);
  if (ts.isConditionalExpression(e)) return [...litTexts(e.whenTrue), ...litTexts(e.whenFalse)];
  return [];
};
const hasArabic = (s) => /[؀-ۿ]/.test(s);
// Seed fields that are technical / never displayed.
const SEED_TECH_FIELDS = new Set(['device', 'userAgent', 'endedReason', 'currentModule', 'source', 'entityType', 'refType', 'key', 'sku', 'code', 'nid', 'phone', 'username', 'ip', 'ipAddress']);
for (const file of [...BACKEND_DIRS.flatMap((d) => walk(d, ['.ts']))]) {
  if (file.endsWith('.test.ts')) continue;
  const rel = path.relative(root, file);
  const isSeed = rel.includes('/seed/');
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const loc = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  (function visit(n) {
    if (ts.isPropertyAssignment(n)) {
      const name = n.name.getText().replace(/['"]/g, '');
      // writeAudit({ key: '…' })
      if (name === 'key' && ts.isObjectLiteralExpression(n.parent) && n.parent.properties.some((p) => p.name?.getText() === 'action')) {
        for (const k of litTexts(n.initializer)) addKey(k, loc(n));
        if (ts.isTemplateExpression(n.initializer)) backendTemplates.push({ where: loc(n), text: `key: ${n.initializer.getText().slice(0, 90)}` });
      }
      // description: `English ${x}` — a sentence built in code instead of key + params
      if (name === 'description' && ts.isTemplateExpression(n.initializer)) {
        const text = n.initializer.head.text + n.initializer.templateSpans.map((x) => x.literal.text).join(' ');
        if (/[A-Za-z]{3,}/.test(text)) backendTemplates.push({ where: loc(n), text: `description: ${n.initializer.getText().slice(0, 90)}` });
      }
    }
    // ap.phrase('…')
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'phrase' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      addKey(n.arguments[0].text, loc(n));
    }
    // Seed data: English free text (names paired with an Arabic sibling are fine).
    if (isSeed && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) {
      const text = ts.isTemplateExpression(n) ? n.head.text + ' ' + n.templateSpans.map((x) => x.literal.text).join(' ') : n.text;
      const p = n.parent;
      // Nearest enclosing field (through conditionals), e.g. device: x ? 'Safari on macOS' : '…'
      let fieldNode = p;
      while (fieldNode && (ts.isConditionalExpression(fieldNode) || ts.isParenthesizedExpression(fieldNode) || ts.isBinaryExpression(fieldNode))) fieldNode = fieldNode.parent;
      const field = fieldNode && ts.isPropertyAssignment(fieldNode) ? fieldNode.name.getText().replace(/['"]/g, '') : null;
      const obj = ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent) ? p.parent : null;
      // `name` is fine next to `nameAr`, `en` next to `ar` — each English field needs its own Arabic twin.
      const twin = field === 'en' ? 'ar' : `${field}Ar`;
      const pairedWithArabic = obj && obj.properties.some((q) => ts.isPropertyAssignment(q) && q.name.getText() === twin);
      // Ledger notes written in the same template form as the services (rendered via noteText()).
      const isNoteTemplate = field === 'note' && NOTE_PREFIXES.some((pre) => text.startsWith(pre));
      let skip = ts.isImportDeclaration(p) || (field && SEED_TECH_FIELDS.has(field)) || pairedWithArabic || hasArabic(text) || isNoteTemplate || AR.has(text.trim());
      // Arguments of ap.*(), writeAudit keys, and user-agent constants are not free text.
      for (let a = p; a && !skip; a = a.parent) {
        if (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) && a.expression.expression.getText() === 'ap') skip = true;
        if (ts.isVariableDeclaration(a) && /^ua/.test(a.name.getText())) skip = true;
        if (ts.isPropertyAssignment(a) && ['metadata', 'completion', 'key'].includes(a.name.getText())) skip = true;
        if (ts.isStatement(a)) break;
      }
      if (!skip && isProse(text) && /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/.test(text) && !/^[\w.-]+@|^[A-Z]{2,}-/.test(text.trim())) seedEnglish.push({ where: loc(n), text: text.trim().slice(0, 90) });
    }
    n.forEachChild(visit);
  })(sf);
}


// ───────── report ─────────
const missingFront = [...usedKeys].filter(([k]) => !AR.has(k));
const missingBack = [...backendKeys].filter(([k]) => !AR.has(k));

const section = (title, rows, fmt) => {
  console.log(`\n${title}: ${rows.length}`);
  for (const r of rows.slice(0, 400)) console.log('  ' + fmt(r));
};
console.log(`Arabic dictionary entries: ${AR.size}`);
console.log(`Keys used via t()/translate(): ${usedKeys.size}`);
console.log(`Backend user-facing keys: ${backendKeys.size}`);
section('Hardcoded English in frontend/src (not wrapped in t())', hardcoded, (h) => `${h.where}  →  ${h.text}`);
section('t() keys missing an Arabic translation', missingFront, ([k, w]) => `${w}  →  ${k}`);
section('Backend keys missing an Arabic translation', missingBack, ([k, w]) => `${w}  →  ${k}`);
section('Backend sentences built from English templates (use key + params)', backendTemplates, (h) => `${h.where}  →  ${h.text}`);
section('English free text in seed data (seed it in Arabic, or pair it with an Arabic field)', seedEnglish, (h) => `${h.where}  →  ${h.text}`);

const total = hardcoded.length + missingFront.length + missingBack.length + backendTemplates.length + seedEnglish.length;
console.log(total ? `\n${total} item(s) need attention.` : '\nAll user-facing strings are localized.');
if (strict && total) process.exit(1);
