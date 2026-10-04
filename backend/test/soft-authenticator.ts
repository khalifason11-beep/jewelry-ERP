// A software WebAuthn authenticator for server tests: real P-256 keys, real CBOR attestation
// ("none") and real ECDSA assertions, so @simplewebauthn/server verifies them exactly as it would a
// browser's. Knobs: user verification on/off, counter behaviour, and overrides of origin / RP ID to
// build hostile responses.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// ── minimal CBOR encoder (what attestation objects and COSE keys need) ──
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor> | Record<string, unknown>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k as Cbor), cbor(x as Cbor)])]);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export interface SoftCredential {
  id: Buffer;
  privateKey: KeyObject;
  counter: number;
  rpId: string;
}

export class SoftAuthenticator {
  readonly credentials: SoftCredential[] = [];
  constructor(
    public opts: {
      /** Proves user verification (fingerprint/face/PIN). False = a touch-only USB key. */
      uv?: boolean;
      /** 'increment' (most authenticators) or 'zero' (always reports 0, e.g. synced passkeys). */
      counter?: 'increment' | 'zero';
    } = {},
  ) {}

  private flags(extra: number) {
    return 0x01 | (this.opts.uv === false ? 0 : 0x04) | extra;
  }

  /** navigator.credentials.create() for the given server options. */
  create(options: { challenge: string; rp: { id?: string } }, origin: string, override: { rpId?: string; origin?: string } = {}) {
    const rpId = override.rpId ?? options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]);
    const id = randomBytes(32);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    const count = Buffer.alloc(4);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(0x40)]), count, Buffer.alloc(16), len, id, cbor(cose)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: override.origin ?? origin, crossOrigin: false }));
    this.credentials.push({ id, privateKey, counter: 0, rpId });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() with one of this authenticator's credentials. */
  get(options: { challenge: string; rpId?: string }, origin: string, override: { rpId?: string; origin?: string; credential?: SoftCredential; counter?: number } = {}) {
    const cred = override.credential ?? this.credentials[0];
    if (!cred) throw new Error('no credential');
    if (this.opts.counter !== 'zero') cred.counter += 1;
    const counter = override.counter ?? (this.opts.counter === 'zero' ? 0 : cred.counter);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const authData = Buffer.concat([sha256(override.rpId ?? options.rpId ?? cred.rpId), Buffer.from([this.flags(0)]), c]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: override.origin ?? origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
