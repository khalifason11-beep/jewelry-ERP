// Screenshots that may be committed (UI-A2, D-ui-10): WebP, a fixed selection, under docs/ux/screens/.
//
// The capture scripts write full JPEG sets to the git-ignored `.ux-shots/` for local review. `publishScreens`
// converts a selection of them to WebP with Chromium's own encoder (no image library to install):
//   - in Arabic and English at 1366x768, 1536x864 and 1920x1080: the three role homes plus the screens the phase
//     changed (`changed`, a regular expression on the file name);
//   - at 1366x768 in Arabic only: every other demo screen;
//   - at 1366x768 in Arabic and English: the empty-production homes (REH-1);
//   - never the "-full" (whole scrolled page) images.
// `npm run check:assets` keeps the result under 4 MB in total and 150 KB per image.

import fs from 'node:fs';
import path from 'node:path';

export const WEBP_QUALITY = 0.55;
export const HOMES = 'home-company-overview|home-branch-dashboard|home-pos';

/** Encode an image buffer (JPEG or PNG) as WebP inside the browser. */
export async function toWebp(browser, buffer, quality = WEBP_QUALITY) {
  const page = await browser.newPage();
  try {
    const b64 = await page.evaluate(
      async ({ src, q }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/webp', q).split(',')[1];
      },
      { src: `data:image/${buffer[0] === 0x89 ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`, q: quality },
    );
    return Buffer.from(b64, 'base64');
  } finally {
    await page.close();
  }
}

/** Which captured files are published (paths relative to the capture folder). */
export function selectScreens(from, changed) {
  const keep = new RegExp(`(${HOMES}${changed ? `|${changed}` : ''})`);
  const out = [];
  for (const set of ['demo', 'empty-production']) {
    const dir = path.join(from, set);
    if (!fs.existsSync(dir)) continue;
    for (const sizeDir of fs.readdirSync(dir).sort()) {
      for (const f of fs.readdirSync(path.join(dir, sizeDir)).sort()) {
        if (!/\.(jpe?g|png)$/.test(f) || /-full\./.test(f)) continue;
        const at1366 = sizeDir.endsWith('1366x768');
        const ok = set === 'empty-production' ? at1366 : keep.test(f) || (at1366 && sizeDir.startsWith('ar-'));
        if (ok) out.push(path.join(set, sizeDir, f));
      }
    }
  }
  return out;
}

/** Replace `to` (docs/ux/screens) with the WebP selection of `from`. Keeps `to/README.md`. */
export async function publishScreens({ browser, from, to, changed }) {
  for (const set of ['demo', 'empty-production']) fs.rmSync(path.join(to, set), { recursive: true, force: true });
  let bytes = 0;
  const files = selectScreens(from, changed);
  for (const rel of files) {
    const webp = await toWebp(browser, fs.readFileSync(path.join(from, rel)));
    const dest = path.join(to, rel.replace(/\.(jpe?g|png)$/, '.webp'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, webp);
    bytes += webp.length;
  }
  return { count: files.length, bytes };
}
