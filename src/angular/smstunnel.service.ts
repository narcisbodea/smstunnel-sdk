import { Injectable, InjectionToken, inject } from '@angular/core';

// ─── Configuration ──────────────────────────────────

export interface SmsTunnelAngularConfig {
  /** Your backend base URL (where SmsTunnelModule is mounted) */
  apiBaseUrl: string;
  /** Function that returns auth headers (e.g. JWT) */
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
}

export interface CreateTokenResult {
  success: boolean;
  token?: string;
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
  error?: string;
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
  data?: Array<{
    id: string;
    clientId: string;
    name: string;
    brand?: string;
    model?: string;
    connected?: boolean;
  }>;
  error?: string;
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

  private get baseUrl(): string {
    return this.config.apiBaseUrl.replace(/\/$/, '');
  }

  private readonly prefix = 'smstunnel';

  private authHeaders(): Record<string, string> {
    return this.config.getAuthHeaders ? this.config.getAuthHeaders() : {};
  }

  // ─── Pairing ────────────────────────────────────────

  /** Get current pairing status */
  async getStatus(): Promise<SmsTunnelStatus> {
    return this.get(`/${this.prefix}/status`);
  }

  /** Create a pairing token (generates QR) */
  async createToken(): Promise<CreateTokenResult> {
    return this.post(`/${this.prefix}/create-token`, {});
  }

  /** Check pairing status for a token (no auth needed) */
  async getPairingStatus(token: string): Promise<PairingStatusResult> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/pairing-status/${token}`);
    return res.json();
  }

  /** Unpair the connected device */
  async unpair(): Promise<{ success: boolean }> {
    return this.post(`/${this.prefix}/unpair`, {});
  }

  /** List active pairings */
  async getPairings(): Promise<PairingInfo[]> {
    return this.get(`/${this.prefix}/pairings`);
  }

  // ─── SMS ────────────────────────────────────────────

  /** Send a single SMS */
  async sendSms(to: string, message: string): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send`, { to, message });
  }

  /** Send 2FA SMS */
  async send2fa(to: string, code: string, template?: string): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send-2fa`, { to, code, template });
  }

  /** Send bulk SMS */
  async sendBulk(messages: Array<{ to: string; message: string }>): Promise<{ success: boolean; results?: any[]; error?: string }> {
    return this.post(`/${this.prefix}/send-bulk`, { messages });
  }

  /** Get SMS delivery status */
  async getSmsStatus(messageId: string): Promise<any> {
    return this.get(`/${this.prefix}/sms-status/${messageId}`);
  }

  /** Get received SMS (inbox) */
  async getReceivedSms(): Promise<any> {
    return this.get(`/${this.prefix}/received`);
  }

  // ─── Devices & Account ─────────────────────────────

  /** List paired devices */
  async getDevices(): Promise<DevicesResult> {
    return this.get(`/${this.prefix}/devices`);
  }

  /** Get account usage stats */
  async getUsage(): Promise<any> {
    return this.get(`/${this.prefix}/usage`);
  }

  // ─── E2E Encryption ────────────────────────────────

  /** Get E2E encryption status for a device */
  async getDeviceE2EStatus(deviceId: string): Promise<{ success: boolean; data?: DeviceE2EStatus; error?: string }> {
    return this.get(`/${this.prefix}/e2e-status/${deviceId}`);
  }

  /** Get device public key for E2E encryption */
  async getDevicePublicKey(deviceId: string): Promise<{ success: boolean; data?: DevicePublicKeyInfo; error?: string }> {
    return this.get(`/${this.prefix}/public-key/${deviceId}`);
  }

  /** Verify device key fingerprint hasn't changed (detect reinstalls) */
  async verifyDeviceKey(deviceId: string, fingerprint: string): Promise<VerifyDeviceKeyResult> {
    return this.post(`/${this.prefix}/verify-key`, { deviceId, fingerprint });
  }

  /** Send encrypted SMS (payload already encrypted with device's RSA public key) */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
  ): Promise<SendSmsResult> {
    return this.post(`/${this.prefix}/send-encrypted`, { encryptedPayload, deviceId, is2FA });
  }

  // ─── Config ─────────────────────────────────────────

  /** Update server URL configuration */
  async updateServerUrl(serverUrl: string): Promise<{ success: boolean }> {
    return this.post(`/${this.prefix}/update-config`, { serverUrl });
  }

  // ─── Internal helpers ──────────────────────────────

  private async get<T = any>(path: string): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.authHeaders(),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message } as any;
    }
  }

  private async post<T = any>(path: string, body: any): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message } as any;
    }
  }
}
