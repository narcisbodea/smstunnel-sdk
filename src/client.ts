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
  /** Keys were exchanged with the phone. */
  e2eEnabled?: boolean;
  deviceFingerprint?: string;
}

/** Added to an answer when SMSTunnel refused the call (the backend passes it through). */
export interface SmsTunnelFailureFields {
  /** The HTTP status SMSTunnel answered with: 403 permission or plan, 404 not found, 429 limit. */
  status?: number;
  /** A stable code on some failures, e.g. `PERMISSION_REQUIRED`. */
  code?: string;
  /** With `PERMISSION_REQUIRED`: the permission the API key lacks, e.g. `sms:inbox`. */
  permission?: string;
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

export interface SendSmsResponse extends SmsTunnelFailureFields {
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

export interface SmsStatusResponse extends SmsTunnelFailureFields {
  success: boolean;
  data?: {
    id: string;
    /** For an encrypted text sent without `to`, the message id in brackets. */
    phoneNumber: string;
    /** An unconfirmed text shows here as `failed` with `unconfirmed: true`; `deliveryStatus` has the real state. */
    status: 'sent' | 'pending' | 'failed' | 'delivered';
    unconfirmed?: boolean;
    deliveryStatus?: 'sent' | 'pending' | 'failed' | 'delivered' | 'unconfirmed';
    sentAt?: string;
    deliveredAt?: string;
    errorMessage?: string | null;
  };
  error?: string;
}

export interface SendBulkSmsRequest {
  messages: Array<{ to: string; message: string }>;
}

export interface SendBulkSmsResponse {
  /** `true` only when every text went out. */
  success: boolean;
  /** One per text, in the order given. */
  results?: Array<{ to: string; messageId?: string; error?: string }>;
  error?: string;
}

export interface Send2faRequest {
  to: string;
  code: string;
  /** `{code}` is replaced with the code; without it the code is added at the end. */
  template?: string;
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

export interface ReceivedSmsResponse extends SmsTunnelFailureFields {
  success: boolean;
  data?: {
    messages: Array<{
      id: string;
      sender: string;
      /** `null` when the phone sent it encrypted. */
      message: string | null;
      isEncrypted: boolean;
      encryptedPayload?: string;
      receivedAt: string;
      subscriptionId?: number;
      simSlot?: number;
      deviceId?: string;
      deviceName?: string;
    }>;
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  };
  error?: string;
}

// --- Devices ---

export interface DevicesResponse extends SmsTunnelFailureFields {
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
}

// --- Account ---

export interface AccountUsageResponse extends SmsTunnelFailureFields {
  success: boolean;
  data?: {
    plan: string;
    accountType: string;
    usage: { smsClean: number; smsBranded: number; twoFaClean: number };
    limits: { smsClean: number | 'unlimited'; twoFaClean: number | 'unlimited' };
    remaining: { smsClean: number | 'unlimited'; twoFaClean: number | 'unlimited' };
    enterprise?: { id: string; name: string };
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

  /**
   * @deprecated SMSTunnel lists pairings only for a dashboard sign-in, so through the backend's API key this
   * answers `{ success: false, status: 401 }`, not a list. Use `getStatus()` and `getDevices()`.
   */
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

  /** Send a 2FA SMS. `{code}` in `template` is replaced with the code. */
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

  /** Send texts to several numbers (one result per text, in your order) */
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
    const res = await fetch(
      `${this.baseUrl}/${this.prefix}/sms-status/${encodeURIComponent(messageId)}`,
      { headers: this.getAuthHeaders() },
    );
    return res.json();
  }

  /**
   * Get received SMS (inbox). The backend's API key must be allowed to read them; otherwise the answer is
   * `{ success: false, status: 403, code: 'PERMISSION_REQUIRED' }`.
   */
  async getReceivedSms(query?: ReceivedSmsQuery): Promise<ReceivedSmsResponse> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
    }
    const qs = params.toString();
    const res = await fetch(`${this.baseUrl}/${this.prefix}/received${qs ? `?${qs}` : ''}`, {
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
      `${this.baseUrl}/${this.prefix}/e2e-status/${encodeURIComponent(deviceId)}`,
      { headers: this.getAuthHeaders() },
    );
    return res.json();
  }

  /** Get device public key for E2E encryption */
  async getDevicePublicKey(deviceId: string): Promise<DevicePublicKeyResponse> {
    const res = await fetch(
      `${this.baseUrl}/${this.prefix}/public-key/${encodeURIComponent(deviceId)}`,
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

  /**
   * Send an encrypted SMS (payload already encrypted with device public key).
   *
   * Give `to` as well on every plan: the number stays visible to SMSTunnel and only the phone reads the
   * words. Without `to` the text is Maximum privacy, which needs the Professional or Enterprise plan.
   */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
    to?: string,
  ): Promise<SendSmsResponse> {
    const res = await fetch(`${this.baseUrl}/${this.prefix}/send-encrypted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({ encryptedPayload, deviceId, is2FA, ...(to !== undefined ? { to } : {}) }),
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
