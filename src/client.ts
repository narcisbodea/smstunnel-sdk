/**
 * Framework-agnostic SMSTunnel client.
 *
 * Works with Angular, Svelte, Astro, Solid, Vanilla JS, or any framework.
 * For React use `smstunnel-sdk/react`, for Vue use `smstunnel-sdk/vue`.
 */
export interface SmsTunnelClientOptions {
  apiBaseUrl: string;
  /** Return the current JWT/auth token. SDK adds Authorization: Bearer header automatically. */
  getToken?: () => string | null;
  /** Full control over auth headers. Takes precedence over getToken. */
  getAuthHeaders?: () => Record<string, string>;
  pollInterval?: number;
}

// --- Status ---

export interface SmsTunnelStatusResponse {
  paired: boolean;
  serverUrl?: string;
  deviceName?: string;
}

// --- Pairing ---

export interface CreateTokenResponse {
  success: boolean;
  token?: string;
  pairingCode?: string;
  qrData?: string;
  expiresAt?: string;
  pollUrl?: string;
  error?: string;
}

export interface PairingStatusResponse {
  status: 'pending' | 'completed' | 'expired' | 'error';
  source?: string;
  displayName?: string;
  pairedDeviceId?: string;
  pairingId?: string;
  error?: string;
}

// --- SMS ---

export interface SendSmsResponse {
  success: boolean;
  messageId?: string;
  queued?: boolean;
  data?: {
    messageId: string;
    branded: boolean;
    queued: boolean;
    remaining: number;
  };
  error?: string;
}

export interface SmsStatusResponse {
  success: boolean;
  data?: {
    messageId: string;
    status: 'sent' | 'pending' | 'failed' | 'delivered';
    recipient: string;
    sentAt?: string;
  };
  error?: string;
}

export interface SendBulkSmsRequest {
  messages: Array<{ to: string; message: string }>;
}

export interface SendBulkSmsResponse {
  success: boolean;
  results?: Array<{ to: string; messageId?: string; error?: string }>;
  error?: string;
}

export interface Send2faRequest {
  to: string;
  code: string;
  template?: string;
}

export interface ReceivedSmsResponse {
  success: boolean;
  data?: Array<{
    from: string;
    message: string;
    receivedAt: string;
  }>;
  error?: string;
}

// --- Devices ---

export interface DevicesResponse {
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

// --- Account ---

export interface AccountUsageResponse {
  success: boolean;
  data?: {
    messagesSent: number;
    messagesReceived: number;
    messagesSentToday: number;
    messagesSentMonth: number;
    dailyLimit?: number;
    monthlyLimit?: number;
  };
  error?: string;
}

// --- E2E Encryption ---

export interface DeviceE2EStatusResponse {
  success: boolean;
  data?: {
    encryptionEnabled: boolean;
    hasPublicKey: boolean;
    publicKeyFingerprint?: string;
    keyCreatedAt?: string;
  };
  error?: string;
}

export interface DevicePublicKeyResponse {
  success: boolean;
  data?: {
    deviceId: string;
    deviceName: string;
    publicKey: string;
  };
  error?: string;
}

export interface VerifyDeviceKeyResponse {
  valid: boolean;
  currentFingerprint?: string;
  needsRePairing: boolean;
}

// --- Pairings list ---

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

// --- Callback ---

export type PairingEventCallback = (event: 'completed' | 'expired' | 'error', data?: any) => void;

export class SmsTunnelClient {
  private readonly baseUrl: string;
  private readonly prefix = 'smstunnel';
  private readonly pollInterval: number;
  private readonly getAuthHeaders: () => Record<string, string>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SmsTunnelClientOptions) {
    this.baseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.pollInterval = options.pollInterval || 3000;

    if (options.getAuthHeaders) {
      this.getAuthHeaders = options.getAuthHeaders;
    } else if (options.getToken) {
      const getToken = options.getToken;
      this.getAuthHeaders = (): Record<string, string> => {
        const token = getToken();
        if (token) return { Authorization: `Bearer ${token}` };
        return {};
      };
    } else {
      this.getAuthHeaders = () => ({});
    }
  }

  // ─── Pairing ───────────────────────────────────────

  /** Get current pairing status */
  async getStatus(): Promise<SmsTunnelStatusResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/status`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  /** Create a pairing token (generates QR data) */
  async createToken(): Promise<CreateTokenResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/create-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
    });
    return res.json();
  }

  /** Check pairing status for a token (no auth needed) */
  async getPairingStatus(token: string): Promise<PairingStatusResponse> {
    const res = await fetch(
      `${this.baseUrl}/${this.prefix}/pairing-status/${token}`,
    );
    return res.json();
  }

  /**
   * Start polling for pairing completion.
   * Returns a cleanup function to stop polling.
   */
  startPolling(token: string, callback: PairingEventCallback): () => void {
    this.stopPolling();

    this.pollTimer = setInterval(async () => {
      try {
        const data = await this.getPairingStatus(token);
        if (data.status === 'completed') {
          this.stopPolling();
          callback('completed', data);
        } else if (data.status === 'expired') {
          this.stopPolling();
          callback('expired', data);
        }
      } catch (err) {
        // ignore polling errors
      }
    }, this.pollInterval);

    return () => this.stopPolling();
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Unpair the connected device */
  async unpair(): Promise<{ success: boolean }> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/unpair`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  /** List active pairings (proxied through backend) */
  async getPairings(): Promise<PairingInfo[]> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/pairings`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  // ─── SMS ───────────────────────────────────────────

  /** Send a single SMS */
  async sendSms(to: string, message: string): Promise<SendSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ to, message }),
    });
    return res.json();
  }

  /** Send a 2FA SMS */
  async send2fa(to: string, code: string, template?: string): Promise<SendSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/send-2fa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ to, code, template }),
    });
    return res.json();
  }

  /** Send bulk SMS */
  async sendBulk(messages: Array<{ to: string; message: string }>): Promise<SendBulkSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/send-bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ messages }),
    });
    return res.json();
  }

  /** Get SMS delivery status */
  async getSmsStatus(messageId: string): Promise<SmsStatusResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/sms-status/${messageId}`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  /** Get received SMS (inbox) */
  async getReceivedSms(): Promise<ReceivedSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/received`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  // ─── Devices & Account ─────────────────────────────

  /** List paired devices */
  async getDevices(): Promise<DevicesResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/devices`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  /** Get account usage stats */
  async getUsage(): Promise<AccountUsageResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/usage`, {
      headers: this.getAuthHeaders(),
    });
    return res.json();
  }

  // ─── E2E Encryption ────────────────────────────────

  /** Get E2E encryption status for a device */
  async getDeviceE2EStatus(deviceId: string): Promise<DeviceE2EStatusResponse> {
    const res = await fetch(
      `${this.baseUrl}/${this.prefix}/e2e-status/${deviceId}`,
      { headers: this.getAuthHeaders() },
    );
    return res.json();
  }

  /** Get device public key for E2E encryption */
  async getDevicePublicKey(deviceId: string): Promise<DevicePublicKeyResponse> {
    const res = await fetch(
      `${this.baseUrl}/${this.prefix}/public-key/${deviceId}`,
      { headers: this.getAuthHeaders() },
    );
    return res.json();
  }

  /** Verify that a stored fingerprint matches the current device key */
  async verifyDeviceKey(
    deviceId: string,
    fingerprint: string,
  ): Promise<VerifyDeviceKeyResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/verify-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ deviceId, fingerprint }),
    });
    return res.json();
  }

  /** Send an encrypted SMS (payload already encrypted with device public key) */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
  ): Promise<SendSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/send-encrypted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ encryptedPayload, deviceId, is2FA }),
    });
    return res.json();
  }

  // ─── Config ────────────────────────────────────────

  /** Update server URL configuration */
  async updateServerUrl(serverUrl: string): Promise<{ success: boolean }> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/update-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ serverUrl }),
    });
    return res.json();
  }

  /** Destroy - cleanup polling */
  destroy(): void {
    this.stopPolling();
  }
}
