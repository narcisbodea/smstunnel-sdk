import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * What a pairing callback may carry. Both callback routes are public: SMSTunnel's server posts the new phone's API key
 * there, but anyone can post to them. Plain Node, no NestJS.
 *
 * Real values are far inside these bounds: SMSTunnel's tokens are 64 characters, its keys 40, a phone id 24.
 */
export const CALLBACK_LIMITS = {
  /** `token` / `site_token`: visible ASCII, no spaces. */
  token: { min: 16, max: 512 },
  /** `apiKey` / `api_key`: visible ASCII, no spaces. */
  apiKey: { min: 16, max: 512 },
  /** `deviceId`, when present: visible ASCII, no spaces. */
  deviceId: { min: 1, max: 128 },
  /** `deviceName`, when present: any text up to this length; control characters become spaces. */
  deviceName: { max: 256 },
} as const;

export interface CallbackFields {
  token: string;
  apiKey: string;
  deviceId?: string;
  deviceName?: string;
}

export type CallbackReading = { ok: true; fields: CallbackFields } | { ok: false; reason: string };

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// C0 and C1 controls, and the two Unicode line separators: never in a log line or a page.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A token, key or id: a string of visible ASCII characters within the bounds, otherwise undefined. */
function credentialOf(value: unknown, bounds: { min: number; max: number }): string | undefined {
  return typeof value === 'string' &&
    value.length >= bounds.min &&
    value.length <= bounds.max &&
    VISIBLE_ASCII.test(value)
    ? value
    : undefined;
}

/** Missing (undefined, null or an empty string) counts as not sent. */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** The phone's name: undefined when not sent, `false` when refused, otherwise the name without control characters. */
function deviceNameOf(value: unknown): string | undefined | false {
  if (isMissing(value)) return undefined;
  if (typeof value !== 'string' || value.length > CALLBACK_LIMITS.deviceName.max) return false;
  const name = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return name || undefined;
}

/** A value from a request, safe to put in a log line: a short string without control characters, or its type. */
export function describeForLog(value: unknown, max = 40): string {
  if (typeof value !== 'string') return value === null ? 'null' : typeof value;
  const text = value.replace(CONTROL, ' ');
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}...` : text);
}

function fieldsOf(token: unknown, apiKey: unknown, deviceId: unknown, deviceName: unknown): CallbackReading {
  const checkedToken = credentialOf(token, CALLBACK_LIMITS.token);
  if (!checkedToken) return { ok: false, reason: 'the token is missing or is not a token' };
  const checkedKey = credentialOf(apiKey, CALLBACK_LIMITS.apiKey);
  if (!checkedKey) return { ok: false, reason: 'the API key is missing or is not a key' };

  let checkedDeviceId: string | undefined;
  if (!isMissing(deviceId)) {
    checkedDeviceId = credentialOf(deviceId, CALLBACK_LIMITS.deviceId);
    if (!checkedDeviceId) return { ok: false, reason: 'deviceId is not an id' };
  }
  const name = deviceNameOf(deviceName);
  if (name === false) return { ok: false, reason: 'deviceName is not a name' };

  return {
    ok: true,
    fields: {
      token: checkedToken,
      apiKey: checkedKey,
      ...(checkedDeviceId ? { deviceId: checkedDeviceId } : {}),
      ...(name ? { deviceName: name } : {}),
    },
  };
}

/** The body of `POST /smstunnel/callback`: `{ event: 'pairing_completed', token, apiKey, deviceId?, deviceName? }`. */
export function readPairingCallback(body: unknown): CallbackReading {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'the body is not a JSON object' };
  }
  const fields = body as Record<string, unknown>;
  if (fields.event !== 'pairing_completed') {
    return { ok: false, reason: `the event is ${describeForLog(fields.event)}, not "pairing_completed"` };
  }
  return fieldsOf(fields.token, fields.apiKey, fields.deviceId, fields.deviceName);
}

/** The fields of the older WordPress-style callback: `{ site_token, api_key, device_name? }`. */
export function readLegacyCallback(siteToken: unknown, apiKey: unknown, deviceName: unknown): CallbackReading {
  return fieldsOf(siteToken, apiKey, undefined, deviceName);
}

/**
 * Whether `posted` is the stored token. Both are hashed to 32 bytes and compared with `timingSafeEqual`, so neither the
 * time taken nor an exception depends on how much of the token, or how many characters, were right.
 */
export function isStoredToken(stored: unknown, posted: string): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  const expected = createHash('sha256').update(stored, 'utf8').digest();
  const given = createHash('sha256').update(posted, 'utf8').digest();
  return timingSafeEqual(expected, given);
}
