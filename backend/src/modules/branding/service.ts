// Company branding: names, currency labels, invoice footer and logo — all stored as settings
// (and the logo bytes in `branding_assets`). Read by the login page, header, browser title and
// printed invoices through `publicBranding`.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { SystemSettings } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { writeAudit } from '../../core/audit';
import { badRequest, notFound } from '../../core/errors';
import { inspectLogo, LOGO_MAX_BYTES, LOGO_MAX_PX, type LogoProblem } from './image';

/** What any visitor (including the login page) may know about the company. */
export function publicBranding(s: SystemSettings) {
  return {
    company: { nameEn: s.company.nameEn, nameAr: s.company.nameAr },
    currency: { code: s.company.currencyCode, labelEn: s.company.currencyLabelEn, labelAr: s.company.currencyLabelAr },
    logoUrl: s.branding.logoAssetId ? `/api/branding/logo?v=${s.branding.logoAssetId}` : null,
    invoiceFooterEn: s.branding.invoiceFooterEn,
    invoiceFooterAr: s.branding.invoiceFooterAr,
  };
}

const PROBLEM_KEYS: Record<LogoProblem, string> = {
  EMPTY: 'The file is empty',
  TOO_LARGE: 'The logo must be at most {kb} KB',
  UNSUPPORTED_TYPE: 'Only PNG, JPEG or WebP images are accepted',
  TYPE_MISMATCH: 'The file content does not match its type',
  TOO_MANY_PIXELS: 'The logo must be at most {px}×{px} pixels',
  INVALID_DIMENSIONS: 'The image dimensions could not be read',
};

export async function uploadLogo(ctx: Ctx, actor: Actor, bytes: Buffer, declaredType: string | undefined) {
  const r = inspectLogo(bytes, declaredType);
  if (!r.ok) throw badRequest(PROBLEM_KEYS[r.problem], { kb: LOGO_MAX_BYTES / 1024, px: LOGO_MAX_PX });
  const { info } = r;
  return ctx.db.transaction(async (tx) => {
    const [asset] = await tx
      .insert(t.brandingAssets)
      .values({
        kind: 'LOGO',
        mime: info.mime,
        bytes: new Uint8Array(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        width: info.width,
        height: info.height,
        uploadedBy: actor.userId,
      })
      .returning({ id: t.brandingAssets.id });
    await ctx.settings.apply(tx, { 'branding.logoAssetId': asset.id }, { actor: { id: actor.userId, username: actor.username } });
    await writeAudit(tx, actor, {
      action: 'BRANDING_CHANGED',
      entityType: 'settings',
      entityId: 'branding.logoAssetId',
      branchId: null,
      key: 'Company logo updated ({width}×{height} px, {kb} KB)',
      params: { width: info.width, height: info.height, kb: Math.ceil(bytes.length / 1024) },
      metadata: { assetId: asset.id },
    });
    return { assetId: asset.id, width: info.width, height: info.height, size: bytes.length };
  });
}

export async function clearLogo(ctx: Ctx, actor: Actor) {
  await ctx.db.transaction(async (tx) => {
    await ctx.settings.apply(tx, { 'branding.logoAssetId': null }, { actor: { id: actor.userId, username: actor.username } });
    await writeAudit(tx, actor, {
      action: 'BRANDING_CHANGED',
      entityType: 'settings',
      entityId: 'branding.logoAssetId',
      branchId: null,
      key: 'Company logo removed',
      params: {},
    });
  });
  return { ok: true };
}

/** The current logo file (public: shown on the login page). */
export async function currentLogo(ctx: Ctx) {
  const { branding } = await ctx.settings.get();
  if (!branding.logoAssetId) throw notFound('Logo');
  const [a] = await ctx.db.select({ mime: t.brandingAssets.mime, bytes: t.brandingAssets.bytes, sha256: t.brandingAssets.sha256 }).from(t.brandingAssets).where(eq(t.brandingAssets.id, branding.logoAssetId));
  if (!a) throw notFound('Logo');
  return { mime: a.mime, bytes: Buffer.from(a.bytes), etag: `"${a.sha256.slice(0, 32)}"` };
}

