#!/usr/bin/env node
// CAT-1 join guard (OPN-1 plan, owner requirement). A piece's product is optional (migration 0026), so code must never
// join `jewelry_items` to `products` with an INNER join (the piece would vanish from the list, the report or the
// invoice), and a piece's type is its own `jewelry_items.category_id`, never the product's. Run by `npm run typecheck`
// (like the other check: scripts) and `npm run check:item-joins`.
//
// Scanned: backend/src (*.ts). Fails on:
//   * `.innerJoin(t.products, …)` (Drizzle) — a join to products must be `.leftJoin`;
//   * a raw-SQL `JOIN products` that is not a `LEFT JOIN products`;
//   * the type reached through the product: `t.products.categoryId` or `p.category_id` / `products.category_id` in a
//     join condition, outside the catalog module (which lists products themselves, not pieces).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = 'backend/src';
// The catalog lists the products themselves (a product's type is its own category), never pieces.
const CATALOG = new Set(['backend/src/modules/catalog/service.ts']);
const RULES = [
  { re: /\.innerJoin\(\s*t\.products\b/, why: 'an INNER join to products: use .leftJoin (the product of a piece is optional, CAT-1)' },
  { re: /(?<!LEFT\s{1,10}(OUTER\s{1,10})?)\bJOIN\s+"?products"?\b/i, why: 'a raw-SQL JOIN products that is not a LEFT JOIN' },
  { re: /t\.products\.categoryId|\bp\.category_id\b|\bproducts"?\."?category_id\b/, why: "the type through the product: join categories on jewelry_items.category_id", allowCatalog: true },
];

const walk = (dir) =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : rel.endsWith('.ts') ? [rel] : [];
  });

const problems = [];
for (const file of walk(SCAN)) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
    for (const r of RULES) {
      if (r.allowCatalog && CATALOG.has(file)) continue;
      if (r.re.test(line)) problems.push(`${file}:${i + 1}: ${r.why}\n    ${line.trim()}`);
    }
  });
}
if (problems.length) {
  console.error(`check:item-joins: ${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('check:item-joins: no inner join to products, no type through the product (backend/src).');
