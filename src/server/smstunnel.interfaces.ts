export interface SmsTunnelConfig {
  serverUrl: string;
  apiKey: string;
  siteToken: string;
  deviceName: string;
  deviceId: string;
  devicePublicKey: string;
  deviceFingerprint: string;
}

export interface SmsTunnelStorageAdapter {
  getConfig(): Promise<Partial<SmsTunnelConfig>>;
  updateConfig(partial: Partial<SmsTunnelConfig>): Promise<void>;
  clearConfig(): Promise<void>;
}

export interface SmsTunnelModuleOptions {
  storage: SmsTunnelStorageAdapter;
  callbackBaseUrl: string;
  displayName?: string;
  displayUrl?: string;
  enableLegacyCallback?: boolean;

  /** Enterprise App API Key for SaaS mode.
   *  When set, createPairingToken() uses /api/v1/saas/activate
   *  to create sub-accounts under the Enterprise account.
   *  When not set, falls back to /api/v1/pairing/public-create. */
  enterpriseApiKey?: string;

  /** External ID sent to SMSTunnel SaaS activate.
   *  Used to identify this client within the Enterprise account. */
  externalId?: string;
}

export interface SmsTunnelModuleAsyncOptions {
  useFactory: (
    ...args: any[]
  ) => Promise<SmsTunnelModuleOptions> | SmsTunnelModuleOptions;
  inject?: any[];
}

export interface SmsTunnelStatus {
  paired: boolean;
  serverUrl?: string;
  deviceName?: string;
  e2eEnabled?: boolean;
  deviceFingerprint?: string;
}

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
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
  status: string;
  displayName?: string;
  error?: string;
}

export interface PairingCallbackBody {
  event: string;
  token: string;
  apiKey: string;
  deviceId?: string;
  deviceName?: string;
  userId?: string;
}

export interface SaasActivateResult {
  success: boolean;
  isNew?: boolean;
  activation?: {
    id: string;
    subAccountId: string;
    token: string;
    qrData: string;
    expiresAt: string;
  };
  apiKey?: {
    id: string;
    key: string;
    permissions: string[];
  };
  error?: string;
}

export interface LegacyCallbackBody {
  site_token: string;
  api_key: string;
  device_name?: string;
  status?: string;
}

export interface PairWithApiKeyResult {
  success: boolean;
  deviceName?: string;
  error?: string;
}

export interface ExchangeKeysResult {
  success: boolean;
  fingerprint?: string;
  deviceName?: string;
  error?: string;
}

// ─── E2E Encryption ─────────────────────────────

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
