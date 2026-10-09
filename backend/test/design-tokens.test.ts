// UI-A1: the design tokens in frontend/src/index.css keep the contrast that docs/design-reference/tokens.md
// promises (WCAG 2.x). Text needs >= 4.5:1; large text, graphics, focus rings and chart bars need >= 3:1.
// Pure parsing of the CSS: no browser, so it runs in both projects at no cost.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/index.css'), 'utf8');
const theme = css.slice(css.indexOf('@theme {'), css.indexOf('@layer base'));
const tokens = Object.fromEntries([...theme.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
const color = (name: string) => {
  if (name === 'white') return '#ffffff';
  const v = tokens[name];
  if (!v) throw new Error(`token --color-${name} is missing from index.css`);
  return v;
};

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// [foreground, background, minimum, what]
const PAIRS: [string, string, number, string][] = [
  ['ink', 'surface', 4.5, 'primary text on the page'],
  ['ink', 'panel', 4.5, 'primary text on a panel'],
  ['ink-2', 'surface', 4.5, 'secondary text on the page'],
  ['ink-2', 'panel', 4.5, 'secondary text on a panel'],
  ['ink-3', 'surface', 4.5, 'meta text on the page'],
  ['ink-3', 'panel', 4.5, 'meta text on a panel'],
  ['white', 'navy', 4.5, 'primary button, Sales card'],
  ['on-navy', 'navy', 4.5, 'sidebar items'],
  ['on-navy', 'navy-2', 4.5, 'active sidebar item'],
  ['on-navy-soft', 'navy', 4.5, 'sub-lines on navy'],
  ['on-navy-muted', 'navy', 4.5, 'sidebar group titles'],
  ['crit', 'crit-bg', 4.5, 'critical badge'],
  ['warn', 'warn-bg', 4.5, 'warning badge'],
  ['ok', 'ok-bg', 4.5, 'success badge'],
  ['ink-2', 'neutral-bg', 4.5, 'info badge'],
  ['crit', 'surface', 4.5, 'danger (outlined) button, field errors'],
  ['gold', 'navy', 3, 'focus ring and active marker on navy'],
  ['navy', 'surface', 3, 'inner focus ring on light surfaces'],
  ['b1', 'surface', 3, 'branch colour 1 on white'],
  ['b2', 'surface', 3, 'branch colour 2 on white'],
  ['b3', 'surface', 3, 'branch colour 3 on white'],
  ['b4', 'surface', 3, 'branch colour 4 on white'],
  ['b1', 'panel', 3, 'branch colour 1 on a panel'],
  ['b2', 'panel', 3, 'branch colour 2 on a panel'],
  ['b3', 'panel', 3, 'branch colour 3 on a panel'],
  ['b4', 'panel', 3, 'branch colour 4 on a panel'],
  // Legacy names still used by the screens (remapped in UI-A1, D-ui-1).
  ['ink-500', 'surface', 4.5, 'legacy meta text'],
  ['ink-400', 'surface', 4.5, 'legacy muted text (e.g. "Walk-in"), UI-A2'],
  ['ink-400', 'panel', 4.5, 'legacy muted text on a panel, UI-A2'],
  ['ink-600', 'canvas', 4.5, 'legacy secondary text on a panel'],
  ['ink-300', 'ink-900', 4.5, 'legacy text on navy'],
];

describe('design tokens (UI-A1)', () => {
  it('the token values equal tokens.md (source: the approved mockups)', () => {
    expect(tokens).toMatchObject({
      navy: '#0f1629', 'navy-2': '#232d45', 'navy-3': '#3a4562', 'on-navy': '#c8cedb', 'on-navy-soft': '#aeb6c8', 'on-navy-muted': '#7f8aa5',
      gold: '#c9a24b', 'gold-soft': '#f5ecd6', ink: '#0f1629', 'ink-2': '#4b5570', 'ink-3': '#646d82',
      surface: '#ffffff', panel: '#f4f5f8', 'neutral-bg': '#eef0f4', line: '#e4e7ee',
      crit: '#b91c1c', 'crit-bg': '#fee2e2', warn: '#b45309', 'warn-bg': '#fef3c7', ok: '#047857', 'ok-bg': '#d1fae5',
      b1: '#0f1629', b2: '#1e6b66', b3: '#a2824d', b4: '#7487cb',
    });
    for (const [name, px] of Object.entries({ meta: 13, body: 15, section: 17, title: 20, figure: 22, kpi: 24 })) {
      expect(theme, `--text-${name}`).toMatch(new RegExp(`--text-${name}:\\s*${px}px`));
    }
    for (const [name, px] of Object.entries({ panel: 20, card: 16, row: 12, control: 10, badge: 6 })) {
      expect(theme, `--radius-${name}`).toMatch(new RegExp(`--radius-${name}:\\s*${px}px`));
    }
  });

  it.each(PAIRS)('%s on %s is at least %s:1 (%s)', (fg, bg, min) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(min);
  });

  it('never white text on gold (2.4:1): no rule in the stylesheet puts white on the gold accent', () => {
    expect(contrast('#ffffff', color('gold'))).toBeLessThan(3);
  });
});
