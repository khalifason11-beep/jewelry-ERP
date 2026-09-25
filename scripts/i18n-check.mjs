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
//    notifications, Hasad errors) must exist in frontend/src/lib/i18n-ar.ts.

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
    // toast.success('English'), toast.info(`English ${x}`)…
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['success', 'error', 'info', 'fromError'].includes(n.expression.name.text)) {
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

const total = hardcoded.length + missingFront.length + missingBack.length;
console.log(total ? `\n${total} item(s) need attention.` : '\nAll user-facing strings are localized.');
if (strict && total) process.exit(1);
