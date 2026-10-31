/**
 * SMSTunnel E2E encryptor (Node-only).
 *
 * Implements the shared interop format described in
 * `docs/e2e-v2-hybrid-spec.md`. This module turns a JSON payload (e.g.
 * `{"to":"+40...","message":"..."}`) into the `encryptedPayload` transport
 * string that the SMSTunnel backend relays to the paired Android device, which
 * decrypts it with its RSA private key.
 *
 * Two on-the-wire formats are supported:
 *
 *   v1 (legacy, DEFAULT): RSA PKCS#1 v1.5 directly over the UTF-8 payload.
 *       transport = base64( RSA_PKCS1_v1.5_encrypt( utf8(payloadJson) ) )
 *       Limited to ~245 bytes for RSA-2048, so long messages fail.
 *
 *   v2 (hybrid, opt-in): AES-256-GCM for the payload + RSA-OAEP(SHA-1) for the
 *       AES key. No payload-size limit.
 *       envelope  = { v:2, k, iv, ct, t }  (all base64)
 *       transport = base64( utf8( JSON.stringify(envelope) ) )
 *
 * IMPORTANT — interop parameters (identical across WP PHP / Flutter Dart / SDK):
 *   - RSA-OAEP uses MGF1 + hash = SHA-1 (NOT SHA-256). `crypto.publicEncrypt`
 *     with `RSA_PKCS1_OAEP_PADDING` and no `oaepHash` defaults to SHA-1, which
 *     matches PHP `OPENSSL_PKCS1_OAEP_PADDING` and Dart `OAEPEncoding` defaults.
 *   - AES-256-GCM: 32-byte random key, 12-byte random IV/nonce, 16-byte tag,
 *     no AAD.
 *   - All envelope fields are standard base64 (with `=` padding).
 *
 * `crypto` is a Node built-in; these helpers run server-side only (the NestJS
 * `/server` module and the standalone `/node` client), never in the browser.
 */

// Import the Node built-in. tsup keeps `node:crypto` external for both the
// `node` (platform: 'node') and `server` entry points, so it is never bundled.
import * as crypto from 'node:crypto';

/** On-the-wire E2E format. */
export type E2eVersion = 1 | 2;

/** Shape of the v2 hybrid envelope (all values base64). */
export interface E2eHybridEnvelope {
  /** Format version. Always `2` for the hybrid envelope. */
  v: 2;
  /** base64( RSA-OAEP(SHA-1) encrypted 32-byte AES key ). */
  k: string;
  /** base64( 12-byte AES-GCM nonce ). */
  iv: string;
  /** base64( AES-256-GCM ciphertext ). */
  ct: string;
  /** base64( 16-byte GCM auth tag ). */
  t: string;
}

/**
 * v1 (legacy) encryptor — RSA PKCS#1 v1.5 directly over the payload.
 *
 * This is the default format and must NOT change: existing paired devices that
 * only understand v1 rely on it.
 *
 * @param payloadJson  UTF-8 JSON payload (e.g. `{"to":"+40...","message":"..."}`).
 * @param publicKeyPem Device RSA public key in PEM (SPKI / PKCS#1) form.
 * @returns base64 transport string.
 * @throws if the payload exceeds the RSA modulus capacity (~245 bytes for RSA-2048).
 */
export function encryptPayloadV1(payloadJson: string, publicKeyPem: string): string {
  const ciphertext = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(payloadJson, 'utf8'),
  );
  return ciphertext.toString('base64');
}

/**
 * v2 (hybrid) encryptor — AES-256-GCM payload + RSA-OAEP(SHA-1) key wrap.
 *
 * Produces the exact envelope the Flutter app's `_decryptHybridV2` expects.
 * Has no practical payload-size limit, so it fixes the v1 ~245-byte ceiling.
 *
 * @param payloadJson  UTF-8 JSON payload.
 * @param publicKeyPem Device RSA public key in PEM form.
 * @returns base64( utf8( JSON.stringify(envelope) ) ).
 */
export function encryptPayloadV2(payloadJson: string, publicKeyPem: string): string {
  // AES-256-GCM: 32-byte key, 12-byte nonce.
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(payloadJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // RSA-OAEP wrap of the AES key. Omitting `oaepHash` => SHA-1 (interop default).
  const ek = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    aesKey,
  );

  const envelope: E2eHybridEnvelope = {
    v: 2,
    k: ek.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    t: tag.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/** Options controlling which E2E format the dispatcher emits. */
export interface EncryptPayloadOptions {
  /**
   * Master feature flag for the v2 hybrid format. Default `false`.
   * Mirrors `SmsTunnelModuleOptions.e2eHybrid` / backend `E2E_HYBRID_ENABLED`.
   * When `false`, ALL messages are v1 regardless of device capability.
   */
  e2eHybrid?: boolean;
  /**
   * The paired device's advertised E2E capability (from the backend, e.g.
   * `device.e2eVersion`). v2 is only used when this is `>= 2`. When unknown
   * (`undefined`), the dispatcher conservatively falls back to v1.
   */
  deviceE2eVersion?: number;
}

/**
 * Gated dispatcher. Chooses v2 ONLY when BOTH conditions hold:
 *   1. `e2eHybrid === true` (feature flag ON), AND
 *   2. `deviceE2eVersion >= 2` (device advertises v2 support).
 *
 * Otherwise it falls back to v1 — including when the device capability is
 * unknown — so old phones are never sent a format they cannot read.
 *
 * @returns the base64 transport string for the chosen format.
 */
export function encryptPayload(
  payloadJson: string,
  publicKeyPem: string,
  options?: EncryptPayloadOptions,
): string {
  const useV2 =
    options?.e2eHybrid === true &&
    typeof options.deviceE2eVersion === 'number' &&
    options.deviceE2eVersion >= 2;

  return useV2
    ? encryptPayloadV2(payloadJson, publicKeyPem)
    : encryptPayloadV1(payloadJson, publicKeyPem);
}

/**
 * Backward-compatible decryptor (v1 + v2), the symmetric counterpart of the
 * encryptors above and a mirror of the Flutter `decryptSMS` logic. Useful for
 * round-trip tests and any consumer that holds the device private key.
 *
 * Detection: base64-decode the transport string; if the bytes are valid UTF-8
 * JSON with `v === 2`, treat as a v2 envelope; otherwise fall back to v1 (raw
 * RSA PKCS#1 v1.5 ciphertext, which is not valid JSON).
 *
 * NOTE on v1: Node 17+ refuses `RSA_PKCS1_PADDING` for *private* decryption
 * (Bleichenbacher hardening), so the v1 fallback cannot be decrypted with
 * `crypto.privateDecrypt` on modern Node and throws a clear error. This does
 * not affect the encryptors — v1 *encryption* (`publicEncrypt`) still works,
 * and the real v1 decryptor is the Flutter app (PointyCastle), not Node. v2
 * (OAEP + GCM) decrypts fine on all supported Node versions.
 *
 * @param transport     base64 transport string produced by an encryptor.
 * @param privateKeyPem RSA private key in PEM form.
 * @returns the decrypted UTF-8 payload JSON string.
 */
export function decryptPayload(transport: string, privateKeyPem: string): string {
  const transportBytes = Buffer.from(transport, 'base64');

  // --- v2 detection (hybrid envelope) ---
  try {
    const maybeJson = transportBytes.toString('utf8');
    const obj = JSON.parse(maybeJson);
    if (obj && typeof obj === 'object' && obj.v === 2) {
      return decryptHybridV2(obj as E2eHybridEnvelope, privateKeyPem);
    }
    // Valid JSON but not a v2 envelope -> fall through to v1.
  } catch {
    // Not a v2 envelope (decode/parse failed) -> legacy v1 path below.
  }

  // --- v1 (legacy) path: RSA PKCS#1 v1.5 directly over the payload ---
  try {
    const plaintext = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      transportBytes,
    );
    return plaintext.toString('utf8');
  } catch (err: any) {
    if (err?.code === 'ERR_INVALID_ARG_VALUE' || /RSA_PKCS1_PADDING/.test(err?.message ?? '')) {
      throw new Error(
        'v1 (RSA PKCS#1 v1.5) private decryption is not supported on this Node version ' +
          '(Node 17+ blocks it). The v1 decryptor is the Flutter app, not the SDK; ' +
          'use v2 (hybrid) if you need to decrypt with Node.',
      );
    }
    throw err;
  }
}

/** Decrypt a v2 hybrid envelope. Internal helper for {@link decryptPayload}. */
function decryptHybridV2(envelope: E2eHybridEnvelope, privateKeyPem: string): string {
  const ek = Buffer.from(envelope.k, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.t, 'base64');

  // RSA-OAEP(SHA-1) unwrap of the AES key (omit oaepHash => SHA-1).
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    ek,
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}
