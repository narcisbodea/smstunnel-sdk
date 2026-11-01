import { Injectable, InjectionToken, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';

// ─── Configuration ──────────────────────────────────

export interface SmsTunnelAngularConfig {
  /** Your backend base URL (where SmsTunnelModule is mounted) */
  apiBaseUrl: string;
  /** Function that returns the current JWT/auth token. SDK adds Authorization: Bearer header automatically. */
  getToken?: () => string | null;
  /** Full control over auth headers. Takes precedence over getToken. */
  getAuthHeaders?: () => Record<string, string>;
  /** Poll interval in ms (default: 3000) */
  pollInterval?: number;
}

export const SMSTUNNEL_CONFIG = new InjectionToken<SmsTunnelAngularConfig>('SMSTUNNEL_CONFIG');

export function provideSmsTunnel(config: SmsTunnelAngularConfig) {
  return { provide: SMSTUNNEL_CONFIG, useValue: config };
}

// ─── Response types ─────────────────────────────────

export interface SmsTunnelStatus {
  paired: boolean;
  serverUrl?: string;
  deviceName?: string;
  /** Keys were exchanged with the phone. */
  e2eEnabled?: boolean;
  deviceFingerprint?: string;
}

export interface CreateTokenResult {
  success: boolean;
  token?: string;
  /** Missing in Enterprise mode, where the phone links by the QR code only. */
  pairingCode?: string;
  qrData?: string;
  expiresAt?: string;
  pollUrl?: string;
  error?: string;
}

export interface PairingStatusResult {
  status: 'pending' | 'completed' | 'expired' | 'error';
  source?: string;
  displayName?: string;
  pairedDeviceId?: string;
  pairingId?: string;
  error?: string;
}

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  /** `true` when the phone was offline: it gets the text when it is back. */
  queued?: boolean;
  error?: string;
  /** On a failure: the HTTP status SMSTunnel answered with (403: permission or plan, 429: limit). */
  status?: number;
  /** On some failures: a stable code, e.g. `PERMISSION_REQUIRED`. */
  code?: string;
}

export interface ReceivedSmsQuery {
  limit?: number;
  page?: number;
  /** ISO date: only texts received after it. */
  since?: string;
  /** Part of the sender's number. */
  phone?: string;
  deviceId?: string;
}

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

export interface DevicesResult {
  success: boolean;
  data?: {
    devices: Array<{
      id: string;
      name: string;
      isOnline: boolean;
      lastSeenAt?: string;
    }>;
    online: number;
    total: number;
  };
  error?: string;
  status?: number;
  code?: string;
}

export interface PairingInfo {
  _id: string;
  deviceId: string;
  type: string;
  name: string;
  status: 'active' | 'paused' | 'revoked';
  messagesSent: number;
  createdAt: string;
  source: string;
}

// ─── Service ────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class SmsTunnelService {
  private readonly config = inject(SMSTUNNEL_CONFIG);
  private readonly http = inject(HttpClient);

  private get baseUrl(): string {
    return this.config.apiBaseUrl.replace(/\/$/, '');
  }

  private readonly prefix = 'smstunnel';

  // ─── Pairing ────────────────────────────────────────

  /** Get current pairing status */
  getStatus(): Promise<SmsTunnelStatus> {
    return this.get(`/${this.prefix}/status`);
  }

  /** Create a pairing token (generates QR) */
  createToken(): Promise<CreateTokenResult> {
    return this.post(`/${this.prefix}/create-token`, {});
  }

  /** Check pairing status for a token (no auth needed) */
  getPairingStatus(token: string): Promise<PairingStatusResult> {
    return this.get(`/${this.prefix}/pairing-status/${token}`);
  }

  /** Unpair the connected device */
  unpair(): Promise<{ success: boolean }> {
    return this.post(`/${this.prefix}/unpair`, {});
  }

  /**
   * @deprecated SMSTunnel lists pairings only for a dashboard sign-in, so through the backend's API key this
   * answers `{ success: false, status: 401 }`, not a list. Use `getStatus()` and `getDevices()`.
   */
  getPairings(): Promise<PairingInfo[]> {
    return this.get(`/${this.prefix}/pairings`);
  }

  // ─── SMS ────────────────────────────────────────────

  /** Send a single SMS */
  sendSms(to: string, message: string): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send`, { to, message });
  }

  /** Send 2FA SMS. `{code}` in `template` is replaced with the code. */
  send2fa(to: string, code: string, template?: string): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send-2fa`, { to, code, template });
  }

  /** Send texts to several numbers (one result per text, in your order) */
  sendBulk(
    messages: Array<{ to: string; message: string }>,
  ): Promise<{ success: boolean; results?: Array<{ to: string; messageId?: string; error?: string }>; error?: string }> {
    return this.post(`/${this.prefix}/send-bulk`, { messages });
  }

  /** Get SMS delivery status */
  getSmsStatus(messageId: string): Promise<any> {
    return this.get(`/${this.prefix}/sms-status/${encodeURIComponent(messageId)}`);
  }

  /**
   * Get received SMS (inbox). The backend's API key must be allowed to read them; otherwise the answer is
   * `{ success: false, status: 403, code: 'PERMISSION_REQUIRED' }`.
   */
  getReceivedSms(query?: ReceivedSmsQuery): Promise<any> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
    }
    const qs = params.toString();
    return this.get(`/${this.prefix}/received${qs ? `?${qs}` : ''}`);
  }

  // ─── Devices & Account ─────────────────────────────

  /** List paired devices */
  getDevices(): Promise<DevicesResult> {
    return this.get(`/${this.prefix}/devices`);
  }

  /** Get account usage stats */
  getUsage(): Promise<any> {
    return this.get(`/${this.prefix}/usage`);
  }

  // ─── E2E Encryption ────────────────────────────────

  /** Get E2E encryption status for a device */
  getDeviceE2EStatus(deviceId: string): Promise<{ success: boolean; data?: DeviceE2EStatus; error?: string }> {
    return this.get(`/${this.prefix}/e2e-status/${encodeURIComponent(deviceId)}`);
  }

  /** Get device public key for E2E encryption */
  getDevicePublicKey(deviceId: string): Promise<{ success: boolean; data?: DevicePublicKeyInfo; error?: string }> {
    return this.get(`/${this.prefix}/public-key/${encodeURIComponent(deviceId)}`);
  }

  /** Verify device key fingerprint hasn't changed (detect reinstalls) */
  verifyDeviceKey(deviceId: string, fingerprint: string): Promise<VerifyDeviceKeyResult> {
    return this.post(`/${this.prefix}/verify-key`, { deviceId, fingerprint });
  }

  /**
   * Send encrypted SMS (payload already encrypted with device's RSA public key).
   * Give `to` as well: without it the text is Maximum privacy (Professional and Enterprise plans only).
   */
  sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
    to?: string,
  ): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send-encrypted`, {
      encryptedPayload,
      deviceId,
      is2FA,
      ...(to !== undefined ? { to } : {}),
    });
  }

  // ─── Config ─────────────────────────────────────────

  /** Update server URL configuration */
  updateServerUrl(serverUrl: string): Promise<{ success: boolean }> {
    return this.post(`/${this.prefix}/update-config`, { serverUrl });
  }

  // ─── Internal helpers ──────────────────────────────

  private authHeaders(): Record<string, string> {
    if (this.config.getAuthHeaders) {
      return this.config.getAuthHeaders();
    }
    if (this.config.getToken) {
      const token = this.config.getToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    }
    return {};
  }

  private get<T = any>(path: string): Promise<T> {
    return lastValueFrom(
      this.http.get<T>(`${this.baseUrl}${path}`, { headers: this.authHeaders() }),
    );
  }

  private post<T = any>(path: string, body: any): Promise<T> {
    return lastValueFrom(
      this.http.post<T>(`${this.baseUrl}${path}`, body, { headers: this.authHeaders() }),
    );
  }
}
