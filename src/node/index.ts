/**
 * SMSTunnel Node.js Client
 *
 * Standalone client that connects directly to the SMSTunnel API.
 * Works in Node.js (18+) without NestJS or any framework.
 *
 * @example
 * ```typescript
 * import { SmsTunnelNodeClient } from '@narcisbodea/smstunnel-sdk/node';
 *
 * const client = new SmsTunnelNodeClient({
 *   apiKey: 'sk_live_xxx',
 *   serverUrl: 'https://smstunnel.io',
 * });
 *
 * // Send SMS
 * const result = await client.sendSms('+40721123456', 'Hello!');
 *
 * // E2E: check status, get public key, send encrypted
 * const e2e = await client.getDeviceE2EStatus('device-id');
 * ```
 *
 * Every method throws {@link SmsTunnelApiError} when SMSTunnel answers with an error status; it carries the
 * HTTP `status`, the `code` (e.g. `PERMISSION_REQUIRED`) and the body.
 */

import {
  encryptPayload,
  encryptPayloadV1,
  encryptPayloadV2,
} from '../shared/e2e-crypto';
import { sealText } from '../shared/sealed-crypto';
import type { SealedCertificate } from '../shared/sealed-crypto';
import { SmsTunnelApiError, readBody } from '../shared/api-error';
import { pairingTokenOf } from '../shared/pairing-token';

// ─── Options ────────────────────────────────────────

export interface SmsTunnelNodeClientOptions {
  /** SMSTunnel API key (sk_live_...) */
  apiKey: string;
  /** SMSTunnel server URL (default: https://smstunnel.io) */
  serverUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /**
   * Opt-in to the E2E v2 hybrid format (AES-256-GCM + RSA-OAEP) when the SDK
   * encrypts payloads itself (see `encrypt()` / `encryptAndSendSms()`).
   *
   * Default `false` → all SDK-side encryption stays on the v1 (RSA PKCS#1 v1.5)
   * format. Even when `true`, v2 is only used for a device that advertises
   * `e2eVersion >= 2`; everything else falls back to v1. Mirrors the backend
   * `E2E_HYBRID_ENABLED` flag and the WP `smstunnel_e2e_hybrid` option.
   */
  e2eHybrid?: boolean;
}

/** Options for a plain text. */
export interface SendOptions {
  /** Used for a number without `+` or `00`, e.g. `+40`. The phone's own setting wins when it has one. */
  defaultCountryCode?: string;
}

// ─── Response types ─────────────────────────────────

export interface SendSmsResponse {
  success: boolean;
  messageId?: string;
  /** `true` when the phone was offline: it gets the text when it is back. */
  queued?: boolean;
  data?: {
    messageId: string;
    branded: boolean;
    queued?: boolean;
    remaining: { clean: number; total: number | string };
  };
  error?: string;
}

export interface SendBulkSmsResponse {
  success: boolean;
  data?: {
    /** In the order of the numbers you gave. */
    messageIds: string[];
    branded: boolean;
    count: number;
    remaining: { clean: number; total: number | string };
  };
  error?: string;
}

/** Where a text is now. `unconfirmed`: handed to the SIM, but the phone got no confirmation (final, never retried). */
export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'unconfirmed';

export interface MessageStatusResponse {
  success: boolean;
  data?: {
    id: string;
    /** For an encrypted text sent without `to`, the message id in brackets. */
    phoneNumber: string;
    /** An unconfirmed text shows here as `failed` with `unconfirmed: true`; `deliveryStatus` has the real state. */
    status: 'pending' | 'sent' | 'delivered' | 'failed';
    unconfirmed?: boolean;
    deliveryStatus?: MessageDeliveryStatus;
    sentAt?: string;
    deliveredAt?: string;
    errorMessage?: string | null;
  };
  error?: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  isOnline: boolean;
  lastSeenAt?: string;
  /** @deprecated Never sent by the server; the SDK fills it from `lastSeenAt`. Use `lastSeenAt`. */
  lastSeen?: string;
}

export interface DevicesResponse {
  success: boolean;
  data?: {
    devices: DeviceSummary[];
    online: number;
    total: number;
  };
  error?: string;
}

/** Usage counted for today. A client of a company account shares the company's quota and sees it here. */
export interface AccountUsage {
  plan: string;
  accountType: string;
  usage: { smsClean: number; smsBranded: number; twoFaClean: number };
  limits: { smsClean: number | 'unlimited'; twoFaClean: number | 'unlimited' };
  remaining: { smsClean: number | 'unlimited'; twoFaClean: number | 'unlimited' };
  /** Present for a client of a company account. */
  enterprise?: { id: string; name: string };
}

export interface AccountUsageResponse {
  success: boolean;
  data?: AccountUsage & Record<string, any>;
  error?: string;
}

export interface ReceivedSms {
  id: string;
  /** The number that sent it. */
  sender: string;
  /** `null` when the phone sent it encrypted (see `encryptedPayload`). */
  message: string | null;
  isEncrypted: boolean;
  encryptedPayload?: string;
  receivedAt: string;
  subscriptionId?: number;
  simSlot?: number;
  deviceId?: string;
  deviceName?: string;
  /** @deprecated Never sent by the server; the SDK fills it from `sender`. Use `sender`. */
  from: string;
  /** @deprecated Never sent by the server; the SDK fills it from `message`. Use `message`. */
  body: string | null;
}

export interface ReceivedSmsResponse {
  success: boolean;
  data?: {
    messages: ReceivedSms[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  };
  error?: string;
}

// ─── E2E types ──────────────────────────────────────

export interface DeviceE2EStatus {
  encryptionEnabled: boolean;
  hasPublicKey: boolean;
  publicKeyFingerprint?: string;
  keyCreatedAt?: string;
}

export interface DevicePublicKeyInfo {
  deviceId: string;
  deviceName: string;
  publicKey: string;
}

export interface VerifyDeviceKeyResult {
  valid: boolean;
  currentFingerprint?: string;
  needsRePairing: boolean;
}

// ─── Pairing types ──────────────────────────────────

export interface E2EPairingResponse {
  success: boolean;
  data?: {
    token: string;
    qrData: string;
    expiresAt: string;
  };
  error?: string;
}

export interface E2EPairingStatusResponse {
  success: boolean;
  data?: {
    status: 'pending' | 'completed' | 'expired';
    publicKey?: string;
    publicKeyFingerprint?: string;
    deviceId?: string;
    deviceName?: string;
    /** The formats the phone reads: `2` means it reads the hybrid format. Pass it to `encrypt()`. */
    e2eVersion?: number;
  };
  error?: string;
}

export interface PairingTokenStatusResponse {
  status: 'pending' | 'completed' | 'expired';
  source?: string;
  displayName?: string;
  pairedDeviceId?: string;
  pairingId?: string;
}

/** A QR code (and a code to type) for a phone to link to your software. */
export interface PublicPairingTokenResponse {
  token: string;
  /** The same link as a code the user can type in the app. */
  pairingCode: string;
  /** Show this as the QR code. */
  qrData: string;
  qrDataRaw: { s: string; t: string; n: string; v: number };
  expiresAt: string;
  /** `GET` it (no key needed) to see whether the phone has linked. */
  pollUrl: string;
}

// ─── Enterprise types ───────────────────────────────

export type EnterpriseActivationState = 'pending' | 'connected' | 'expired' | 'cancelled';

export interface EnterpriseActivateParams {
  /** Your client's name, shown in the app and in your dashboard. */
  clientName: string;
  /** Your own id for this client. Calling again with the same id replaces its earlier activation. */
  externalId: string;
  /** https URL on a public host that gets `pairing_completed` (with the client's API key) when the phone links. */
  callbackUrl?: string;
  userEmail?: string;
  userName?: string;
  metadata?: Record<string, any>;
}

export interface EnterpriseActivateResponse {
  success: boolean;
  isNew: boolean;
  activation: {
    id: string;
    subAccountId: string;
    /** An older reference. The phone links with {@link EnterpriseActivateResponse.pairingToken}. */
    token: string;
    /** Show this as the QR code. */
    qrData: string;
    qrDataRaw?: Record<string, any>;
    expiresAt: string;
  };
  /** The client's API key. It works for sending once the phone has linked. */
  apiKey: { id: string; key: string; permissions: string[] };
  /** Added by the SDK: the token inside the QR code, the one the callback carries and pairing status answers to. */
  pairingToken?: string;
}

export interface EnterpriseClientResponse {
  success: boolean;
  /** Missing when the client has no pending or linked activation. */
  activation?: {
    id: string;
    status: EnterpriseActivationState;
    subAccountId?: string;
    deviceId?: string;
    connectedAt?: string;
    isOnline?: boolean;
  };
}

export interface EnterpriseActivationStatusResponse {
  success: boolean;
  status: EnterpriseActivationState;
  subAccountId?: string;
  externalId?: string;
  deviceId?: string;
  connectedAt?: string;
  isOnline?: boolean;
}

// ─── Client ─────────────────────────────────────────

export class SmsTunnelNodeClient {
  private readonly apiKey: string;
  private readonly serverUrl: string;
  private readonly timeout: number;
  private readonly e2eHybrid: boolean;

  constructor(options: SmsTunnelNodeClientOptions) {
    if (!options.apiKey) {
      throw new Error('API key is required');
    }
    this.apiKey = options.apiKey;
    this.serverUrl = (options.serverUrl || 'https://smstunnel.io').replace(/\/$/, '');
    this.timeout = options.timeout || 30000;
    this.e2eHybrid = options.e2eHybrid === true;
  }

  // ─── SMS ────────────────────────────────────────────

  /** Send a single SMS */
  async sendSms(
    to: string,
    message: string,
    deviceId?: string,
    options?: SendOptions,
  ): Promise<SendSmsResponse> {
    return this.post('/api/v1/sms/send', { to, message, deviceId, ...countryCode(options) });
  }

  /**
   * Send a 2FA text. It must contain the code (e.g. `123456`, `12-345678`); it counts against the 2FA quota.
   */
  async send2FaSms(
    to: string,
    message: string,
    options?: SendOptions & { deviceId?: string },
  ): Promise<SendSmsResponse> {
    return this.post('/api/v1/sms/send-2fa', {
      to,
      message,
      ...(options?.deviceId ? { deviceId: options.deviceId } : {}),
      ...countryCode(options),
    });
  }

  /** Send the same text to several numbers (up to 100 per call). The phone has to be online. */
  async sendBulkSms(
    to: string[],
    message: string,
    deviceId?: string,
    options?: SendOptions,
  ): Promise<SendBulkSmsResponse> {
    return this.post('/api/v1/sms/send-bulk', { to, message, deviceId, ...countryCode(options) });
  }

  /** Get message delivery status (needs `sms:read`) */
  async getMessageStatus(messageId: string): Promise<MessageStatusResponse> {
    return this.get(`/api/v1/sms/status/${encodeURIComponent(messageId)}`);
  }

  /**
   * Get received SMS (inbox). Needs an API key allowed to read received texts (`sms:inbox`); others get a
   * 403 with `code: 'PERMISSION_REQUIRED'`. Keys made by QR pairing never have it.
   */
  async getReceivedSms(params?: {
    limit?: number;
    page?: number;
    since?: string;
    phone?: string;
    deviceId?: string;
  }): Promise<ReceivedSmsResponse> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.page) query.set('page', String(params.page));
    if (params?.since) query.set('since', params.since);
    if (params?.phone) query.set('phone', params.phone);
    if (params?.deviceId) query.set('deviceId', params.deviceId);
    const qs = query.toString();
    const res = await this.get<ReceivedSmsResponse>(`/api/v1/sms/received${qs ? '?' + qs : ''}`);
    for (const text of res.data?.messages ?? []) {
      text.from = text.sender;
      text.body = text.message;
    }
    return res;
  }

  // ─── Devices ────────────────────────────────────────

  /** List the phones of this key's account, and which are online */
  async getDevices(): Promise<DevicesResponse> {
    const res = await this.get<DevicesResponse>('/api/v1/devices');
    for (const device of res.data?.devices ?? []) {
      device.lastSeen = device.lastSeenAt;
    }
    return res;
  }

  /** Get account usage stats */
  async getUsage(): Promise<AccountUsageResponse> {
    return this.get('/api/v1/account/usage');
  }

  // ─── E2E Encryption ────────────────────────────────

  /** Get E2E encryption status for a device */
  async getDeviceE2EStatus(deviceId: string): Promise<{ success: boolean; data: DeviceE2EStatus }> {
    return this.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/e2e-status`);
  }

  /** Get device public key for E2E encryption */
  async getDevicePublicKey(deviceId: string): Promise<{ success: boolean; data: DevicePublicKeyInfo }> {
    return this.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/public-key`);
  }

  /**
   * Verify that a stored fingerprint matches the current device key.
   * If it doesn't match, the device was reinstalled and re-pairing is needed.
   */
  async verifyDeviceKey(deviceId: string, storedFingerprint: string): Promise<VerifyDeviceKeyResult> {
    const res = await this.getDeviceE2EStatus(deviceId);
    const status = res.data;
    if (!status?.hasPublicKey || !status?.publicKeyFingerprint) {
      return { valid: false, needsRePairing: true };
    }
    const matches = status.publicKeyFingerprint === storedFingerprint;
    return {
      valid: matches,
      currentFingerprint: status.publicKeyFingerprint,
      needsRePairing: !matches,
    };
  }

  /**
   * Send encrypted SMS (payload already encrypted with device RSA public key).
   *
   * Give `to` as well on every plan: the number stays visible to SMSTunnel, so your Messages page can
   * show who each text went to, and only the phone can read the words. Leaving it out, and sealed
   * texts, are Maximum privacy (Professional and Enterprise plans); other plans get a 403.
   */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    options?: { is2FA?: boolean; expectedFingerprint?: string; to?: string },
  ): Promise<SendSmsResponse> {
    // Verify E2E status before sending
    if (options?.expectedFingerprint) {
      const verification = await this.verifyDeviceKey(deviceId, options.expectedFingerprint);
      if (verification.needsRePairing) {
        return {
          success: false,
          error: 'Device key changed since last pairing, re-pairing needed',
        };
      }
    }

    return this.post('/api/v1/sms/send', {
      ...(options?.to !== undefined ? { to: options.to } : {}),
      encrypted: true,
      encryptedPayload,
      deviceId,
      is2FA: options?.is2FA || false,
    });
  }

  /**
   * Maximum privacy: seals the number and the text with your private certificate and sends the packet
   * without `to`. Only your software and the phone holding the certificate can read either.
   * Open the certificate once with {@link openCertificate} and keep the result in memory.
   */
  async sendSealedSms(
    to: string,
    message: string,
    deviceId: string,
    certificate: SealedCertificate,
    options?: { is2FA?: boolean },
  ): Promise<SendSmsResponse> {
    return this.post('/api/v1/sms/send', {
      encrypted: true,
      encryptedPayload: sealText(certificate, { to, message }),
      deviceId,
      is2FA: options?.is2FA || false,
    });
  }

  /**
   * Encrypt a payload for a device with its RSA public key, producing the
   * `encryptedPayload` transport string.
   *
   * Format gating: v2 (hybrid) is used ONLY when this client was constructed
   * with `e2eHybrid: true` AND the device advertises `e2eVersion >= 2`
   * (`deviceE2eVersion`). Otherwise it falls back to v1 (RSA PKCS#1 v1.5), so
   * old phones are never sent a format they cannot read. When the device
   * capability is unknown, v1 is used.
   *
   * @param payload      the SMS payload (object is JSON-stringified) — e.g.
   *                     `{ to, message }`. Strings are passed through as-is.
   * @param publicKeyPem the device RSA public key, in PEM or as the bare base64
   *                     {@link getDevicePublicKey} returns.
   * @param deviceE2eVersion the device's advertised E2E capability, if known
   *                     (e.g. `e2eVersion` from {@link getE2EPairingStatus}).
   */
  encrypt(
    payload: string | Record<string, any>,
    publicKeyPem: string,
    deviceE2eVersion?: number,
  ): string {
    const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return encryptPayload(payloadJson, publicKeyPem, {
      e2eHybrid: this.e2eHybrid,
      deviceE2eVersion,
    });
  }

  /**
   * Convenience: fetch the device public key, encrypt `{ to, message }` with
   * the gated format, and send it as an encrypted SMS in one call.
   *
   * Pass `deviceE2eVersion` if you know the device's advertised capability
   * (from the backend); without it the call stays on v1 even when
   * `e2eHybrid` is enabled.
   */
  async encryptAndSendSms(
    to: string,
    message: string,
    deviceId: string,
    options?: { is2FA?: boolean; deviceE2eVersion?: number; expectedFingerprint?: string },
  ): Promise<SendSmsResponse> {
    const keyRes = await this.getDevicePublicKey(deviceId);
    const publicKeyPem = keyRes?.data?.publicKey;
    if (!publicKeyPem) {
      return { success: false, error: 'Device has no public key. Enable encryption in the SMSTunnel app.' };
    }

    const encryptedPayload = this.encrypt({ to, message }, publicKeyPem, options?.deviceE2eVersion);

    return this.sendEncryptedSms(encryptedPayload, deviceId, {
      to,
      is2FA: options?.is2FA,
      expectedFingerprint: options?.expectedFingerprint,
    });
  }

  // ─── E2E Pairing ───────────────────────────────────

  /** Create E2E pairing request (generates QR code) */
  async createE2EPairing(params?: {
    siteName?: string;
    siteUrl?: string;
  }): Promise<E2EPairingResponse> {
    return this.post('/api/v1/e2e/pair', params || {});
  }

  /** Get E2E pairing status (poll this after creating a pairing) */
  async getE2EPairingStatus(token: string): Promise<E2EPairingStatusResponse> {
    return this.get(`/api/v1/e2e/pair/${encodeURIComponent(token)}`);
  }

  // ─── Unified Pairing v2 ────────────────────────────

  /**
   * A QR code (and a code to type) that links a phone to your software. Whoever scans it links their own
   * phone and SMSTunnel account; when they do, SMSTunnel posts `pairing_completed` to `callbackUrl` with
   * `{ event, token, apiKey, deviceId, deviceName, userId }`. Keep the `apiKey` for that phone, and accept the
   * callback only when its `token` is the one this call returned.
   *
   * Needs no API key (this call doesn't send yours). `callbackUrl` must be https on a public host.
   */
  async createPublicPairingToken(params: {
    displayName: string;
    displayUrl?: string;
    callbackUrl?: string;
    /** Extra fields SMSTunnel keeps with the pairing: `siteName`, `siteUrl`, `siteToken`, `externalId`. */
    context?: Record<string, string>;
    expiresInMinutes?: number;
  }): Promise<PublicPairingTokenResponse> {
    const context = {
      ...(params.context ?? {}),
      ...(params.callbackUrl ? { callbackUrl: params.callbackUrl } : {}),
    };
    return this.request(
      'POST',
      '/api/v1/pairing/public-create',
      {
        source: 'api',
        displayName: params.displayName,
        ...(params.displayUrl ? { displayUrl: params.displayUrl } : {}),
        ...(Object.keys(context).length ? { context } : {}),
        ...(params.expiresInMinutes ? { expiresInMinutes: params.expiresInMinutes } : {}),
      },
      false,
    );
  }

  /**
   * @deprecated SMSTunnel accepts this call only from a dashboard sign-in, not from an API key: with an API key
   * it answers 401. Use {@link createPublicPairingToken} (a phone linking to your software) or, for a company
   * account, {@link activateEnterpriseClient}.
   */
  async createPairingToken(params: {
    source: 'dashboard' | 'wordpress' | 'enterprise' | 'saas' | 'api' | 'e2e';
    displayName: string;
    displayUrl?: string;
    context?: Record<string, any>;
    expiresInMinutes?: number;
  }): Promise<any> {
    return this.post('/api/v1/pairing/create', params);
  }

  /** Get pairing token status (for polling) */
  async getPairingTokenStatus(token: string): Promise<PairingTokenStatusResponse> {
    return this.get(`/api/v1/pairing/${encodeURIComponent(token)}`);
  }

  /**
   * @deprecated SMSTunnel lists pairings only for a dashboard sign-in: with an API key it answers 401.
   */
  async listPairings(): Promise<any[]> {
    return this.get('/api/v1/pairings');
  }

  /**
   * @deprecated SMSTunnel revokes pairings only for a dashboard sign-in: with an API key it answers 401.
   * The phone's owner can unlink it in the app or the dashboard.
   */
  async unpair(pairingId: string): Promise<{ success: boolean }> {
    return this.post(`/api/v1/unpair/${encodeURIComponent(pairingId)}`, {});
  }

  // ─── Enterprise (company accounts) ─────────────────
  // These need the API key of an Enterprise app (permission `enterprise:saas`); other keys get a 403.

  /**
   * Start linking one of your clients: makes (or reuses) the client's account and returns the QR code for
   * the client's phone, and the client's API key. Calling again for the same `externalId` replaces the
   * earlier activation and its key, while a linked phone stays linked. Two overlapping calls for one
   * `externalId` can get a 409 with `code: 'CONCURRENT_ACTIVATION'` or `'ALREADY_CONNECTED'`.
   */
  async activateEnterpriseClient(params: EnterpriseActivateParams): Promise<EnterpriseActivateResponse> {
    const res = await this.post<EnterpriseActivateResponse>('/api/v1/saas/activate', params);
    const pairingToken = pairingTokenOf(res?.activation?.qrData);
    return pairingToken ? { ...res, pairingToken } : res;
  }

  /** The client's current activation by your `externalId`: whether its phone has linked and is online. */
  async getEnterpriseClient(externalId: string): Promise<EnterpriseClientResponse> {
    return this.get(`/api/v1/saas/client/${encodeURIComponent(externalId)}`);
  }

  /** One activation by its id (`activation.id` from {@link activateEnterpriseClient}). */
  async getEnterpriseActivation(activationId: string): Promise<EnterpriseActivationStatusResponse> {
    return this.get(`/api/v1/saas/status/${encodeURIComponent(activationId)}`);
  }

  // ─── Helpers ────────────────────────────────────────

  /**
   * Poll E2E pairing until completed, expired, or timeout.
   * Returns the final status.
   */
  async pollE2EPairing(
    token: string,
    options?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<E2EPairingStatusResponse> {
    const interval = options?.intervalMs || 2000;
    const timeout = options?.timeoutMs || 300000; // 5 min default
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const status = await this.getE2EPairingStatus(token);
      if (status.data?.status !== 'pending') {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return { success: true, data: { status: 'expired' } };
  }

  // ─── Internal ──────────────────────────────────────

  private async get<T = any>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T = any>(path: string, body: any): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, withApiKey = true): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.serverUrl}${path}`, {
        method,
        headers: {
          ...(withApiKey ? { 'X-API-Key': this.apiKey } : {}),
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const data = await readBody(res);
      if (!res.ok) {
        throw new SmsTunnelApiError(res.status, data);
      }
      if (data === undefined || typeof data === 'string') {
        throw new SmsTunnelApiError(res.status, 'SMSTunnel answered with something that is not JSON.');
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function countryCode(options?: SendOptions): { defaultCountryCode?: string } {
  return options?.defaultCountryCode ? { defaultCountryCode: options.defaultCountryCode } : {};
}

// ─── Errors ───────────────────────────────────────────────────────────────────
export { SmsTunnelApiError } from '../shared/api-error';
export type { SmsTunnelErrorBody } from '../shared/api-error';

// ─── E2E encryptors (re-exported for standalone use) ──────────────────────────
export {
  encryptPayload,
  encryptPayloadV1,
  encryptPayloadV2,
  decryptPayload,
} from '../shared/e2e-crypto';
export type {
  E2eVersion,
  E2eHybridEnvelope,
  EncryptPayloadOptions,
} from '../shared/e2e-crypto';
export {
  certificateFingerprint,
  createCertificate,
  openCertificate,
  sealText,
} from '../shared/sealed-crypto';
export type { SealedCertificate, SealedCertificateFile } from '../shared/sealed-crypto';
