/**
 * Private certificates and sealed texts (Maximum privacy, Node-only).
 *
 * Implements `docs/e2e-v3-sealed-spec.md`. A certificate is a random key kept in a file, protected by a
 * password only its owner knows. Everything here runs on the owner's machine: the key and the password
 * never go to SMSTunnel. A sealed text carries the number and the wording inside the packet, so the
 * server can't learn who a text is for, and a phone locked to the certificate refuses anything else.
 */
import * as crypto from 'node:crypto';

/** The certificate file, as the dashboard and {@link createCertificate} write it. Its key is still locked. */
export interface SealedCertificateFile {
  t: 'smstunnel-cert';
  v: 1;
  /** First 8 bytes of SHA-256("smstunnel-cert-id:" + key), as hex. Doubles as the fingerprint. */
  id: string;
  /** A name to recognize it by. */
  n: string;
  kdf: { i: number; s: string };
  iv: string;
  ct: string;
  tag: string;
}

/** An opened certificate. Keep it in memory only. */
export interface SealedCertificate {
  id: string;
  name: string;
  key: Buffer;
}

const PBKDF2_ITERATIONS = 600000;
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;
const SEALED_AAD = 'smstunnel-sealed-v3:';

function certificateId(key: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('smstunnel-cert-id:'), key]))
    .digest()
    .subarray(0, 8)
    .toString('hex');
}

function wrappingKey(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}

/** `a1b2 c3d4 e5f6 0718`: the same fingerprint the dashboard and the phone show. */
export function certificateFingerprint(id: string): string {
  return id.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Makes a certificate on this machine, for those who prefer not to make it in the dashboard.
 * @returns the file to keep (safe to store without the password) and the opened certificate.
 */
export function createCertificate(
  name: string,
  password: string,
): { file: SealedCertificateFile; certificate: SealedCertificate } {
  if (password.length < 12) {
    throw new Error('The certificate password needs at least 12 characters.');
  }
  const key = crypto.randomBytes(32);
  const id = certificateId(key);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey(password, salt, PBKDF2_ITERATIONS), iv);
  cipher.setAAD(Buffer.from(id));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    file: {
      t: 'smstunnel-cert',
      v: 1,
      id,
      n: name,
      kdf: { i: PBKDF2_ITERATIONS, s: salt.toString('base64') },
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    certificate: { id, name, key },
  };
}

/**
 * Opens a certificate with its password. It takes a moment, on purpose.
 *
 * @param file the file's text, or the parsed file.
 * @throws when the text isn't a certificate, or the password is wrong.
 */
export function openCertificate(file: string | SealedCertificateFile, password: string): SealedCertificate {
  const parsed = (typeof file === 'string' ? JSON.parse(file) : file) as SealedCertificateFile;
  const iterations = parsed?.kdf?.i;
  if (
    parsed?.t !== 'smstunnel-cert' ||
    parsed.v !== 1 ||
    !/^[0-9a-f]{16}$/.test(parsed.id ?? '') ||
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw new Error('This is not a valid SMSTunnel certificate.');
  }
  const opener = crypto.createDecipheriv(
    'aes-256-gcm',
    wrappingKey(password, Buffer.from(parsed.kdf.s, 'base64'), iterations),
    Buffer.from(parsed.iv, 'base64'),
  );
  opener.setAAD(Buffer.from(parsed.id));
  opener.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  let key: Buffer;
  try {
    key = Buffer.concat([opener.update(Buffer.from(parsed.ct, 'base64')), opener.final()]);
  } catch {
    throw new Error('Wrong password for this certificate.');
  }
  if (key.length !== 32 || certificateId(key) !== parsed.id) {
    throw new Error('This certificate is damaged.');
  }
  return { id: parsed.id, name: parsed.n || parsed.id, key };
}

/**
 * Seals a text: the number and the wording go inside, padded so the packet doesn't give away the length.
 * Each packet gets an id and a time, so a phone won't send it twice or send an old one.
 *
 * @returns the `encryptedPayload` to send, without `to`.
 */
export function sealText(certificate: SealedCertificate, text: { to: string; message: string }): string {
  const content = { to: text.to, message: text.message, id: crypto.randomUUID(), ts: Date.now() };
  const pad = ' '.repeat(256 - (Buffer.byteLength(JSON.stringify(content)) % 256));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', certificate.key, iv);
  cipher.setAAD(Buffer.from(SEALED_AAD + certificate.id));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ ...content, pad }), 'utf8'), cipher.final()]);
  const packet = {
    v: 3,
    c: certificate.id,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
  };
  return Buffer.from(JSON.stringify(packet), 'utf8').toString('base64');
}
