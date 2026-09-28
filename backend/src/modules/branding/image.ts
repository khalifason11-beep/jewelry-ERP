// Logo validation (decision Q20): PNG, JPEG or WebP only, identified by magic bytes (never by the
// declared type or file name), at most 512 KB and 1024×1024 px. Everything else — SVG, GIF, HTML,
// polyglots with a wrong header, truncated files — is rejected. Dimensions are read from the
// image header without decoding the pixels.

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_PX = 1024;
export const LOGO_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMime = (typeof LOGO_MIME)[number];

export interface ImageInfo {
  mime: LogoMime;
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngInfo(b: Buffer): ImageInfo | null {
  if (b.length < 33 || !PNG_SIG.every((v, i) => b[i] === v)) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return { mime: 'image/webp', width, height };
  }
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

export type LogoProblem = 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'TYPE_MISMATCH' | 'TOO_MANY_PIXELS' | 'INVALID_DIMENSIONS';

/** Validate an uploaded logo. `declared` is the request Content-Type. */
export function inspectLogo(bytes: Buffer, declared: string | undefined): { ok: true; info: ImageInfo } | { ok: false; problem: LogoProblem } {
  if (!bytes.length) return { ok: false, problem: 'EMPTY' };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, problem: 'TOO_LARGE' };
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
  if (!info) return { ok: false, problem: 'UNSUPPORTED_TYPE' };
  if (declared && declared.split(';')[0].trim().toLowerCase() !== info.mime) return { ok: false, problem: 'TYPE_MISMATCH' };
  if (!info.width || !info.height) return { ok: false, problem: 'INVALID_DIMENSIONS' };
  if (info.width > LOGO_MAX_PX || info.height > LOGO_MAX_PX) return { ok: false, problem: 'TOO_MANY_PIXELS' };
  return { ok: true, info };
}
