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
 */

import {
  encryptPayload,
  encryptPayloadV1,
  encryptPayloadV2,
} from '../shared/e2e-crypto';
import { sealText } from '../shared/sealed-crypto';
import type { SealedCertificate } from '../shared/sealed-crypto';

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

// ─── Response types ─────────────────────────────────

export interface SendSmsResponse {
  success: boolean;
  messageId?: string;
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
    messageIds: string[];
    branded: boolean;
    count: number;
    remaining: { clean: number; total: number | string };
  };
  error?: string;
}

export interface MessageStatusResponse {
  success: boolean;
  data?: {
    id: string;
    phoneNumber: string;
    status: 'pending' | 'sent' | 'delivered' | 'failed';
    sentAt?: string;
    deliveredAt?: string;
    errorMessage?: string | null;
  };
  error?: string;
}

export interface DevicesResponse {
  success: boolean;
  data?: {
    devices: Array<{
      id: string;
      name: string;
      isOnline: boolean;
      lastSeen?: string;
    }>;
    online: number;
    total: number;
  };
  error?: string;
}

export interface AccountUsageResponse {
  success: boolean;
  data?: Record<string, any>;
  error?: string;
}

export interface ReceivedSmsResponse {
  success: boolean;
  data?: {
    messages: Array<{
      id: string;
      from: string;
      body: string;
      receivedAt: string;
      deviceId: string;
    }>;
    total: number;
    page: number;
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
  async sendSms(to: string, message: string, deviceId?: string): Promise<SendSmsResponse> {
    return this.post('/api/v1/sms/send', { to, message, deviceId });
  }

  /** Send 2FA SMS */
  async send2FaSms(to: string, message: string): Promise<SendSmsResponse> {
    return this.post('/api/v1/sms/send-2fa', { to, message });
  }

  /** Send bulk SMS */
  async sendBulkSms(
    to: string[],
    message: string,
    deviceId?: string,
  ): Promise<SendBulkSmsResponse> {
    return this.post('/api/v1/sms/send-bulk', { to, message, deviceId });
  }

  /** Get message delivery status */
  async getMessageStatus(messageId: string): Promise<MessageStatusResponse> {
    return this.get(`/api/v1/sms/status/${messageId}`);
  }

  /** Get received SMS (inbox) */
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
    return this.get(`/api/v1/sms/received${qs ? '?' + qs : ''}`);
  }

  // ─── Devices ────────────────────────────────────────

  /** List devices */
  async getDevices(): Promise<DevicesResponse> {
    return this.get('/api/v1/devices');
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
   * texts, are Maximum privacy (Professional and Enterprise plans).
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
   * @param deviceE2eVersion the device's advertised E2E capability, if known.
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

  /** Create pairing token (unified v2 flow) */
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

  /** List all active pairings */
  async listPairings(): Promise<any[]> {
    return this.get('/api/v1/pairings');
  }

  /** Unpair (revoke) a pairing */
  async unpair(pairingId: string): Promise<{ success: boolean }> {
    return this.post(`/api/v1/unpair/${encodeURIComponent(pairingId)}`, {});
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.serverUrl}${path}`, {
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T = any>(path: string, body: any): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

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
