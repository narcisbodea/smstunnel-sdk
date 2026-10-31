export interface SmsTunnelConfig {
  serverUrl: string;
  apiKey: string;
  siteToken: string;
  deviceName: string;
  deviceId: string;
  devicePublicKey: string;
  deviceFingerprint: string;
  /**
   * The paired device's advertised E2E capability (`device.e2eVersion` from the
   * backend). `>= 2` means the device understands the v2 hybrid envelope.
   * Absent/`1` means v1-only. Populated by `exchangeKeys()`.
   */
  deviceE2eVersion: number;
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

  /**
   * Opt-in to the E2E v2 hybrid format (AES-256-GCM + RSA-OAEP) for payloads
   * the SDK encrypts itself (`SmsTunnelService.encrypt()` /
   * `encryptAndSendSms()`).
   *
   * Defaults to `false` → all SDK-side encryption stays on the v1
   * (RSA PKCS#1 v1.5) format, so paired phones that only understand v1 keep
   * working. Even when `true`, v2 is only used for a device that advertises
   * `e2eVersion >= 2`; everything else falls back to v1. Mirrors the backend
   * `E2E_HYBRID_ENABLED` flag and the WordPress `smstunnel_e2e_hybrid` option.
   */
  e2eHybrid?: boolean;

  // ─── Security: built-in auth guard (secure-by-default) ──────────────

  /**
   * Authentication predicate used by the built-in {@link SmsTunnelAuthGuard}
   * to protect every non-public SMSTunnel route (everything except routes
   * marked `@SmsTunnelPublic()`).
   *
   * Return `true` to allow the request, `false` (or throw) to reject it.
   * Receives the underlying framework request object (e.g. the Express
   * request) so you can validate a session, JWT, header, etc.
   *
   * If NEITHER `authenticate` NOR `authGuard` is provided, the guard
   * fails closed: all non-public routes are blocked. This makes the
   * quickstart secure-by-default instead of silently open.
   */
  authenticate?: (req: any) => boolean | Promise<boolean>;

  /**
   * Alternative to {@link authenticate}: supply your own NestJS guard.
   * Accepts a `CanActivate` class (no-arg constructor) or instance.
   * For guards that need dependency injection, prefer `authenticate`.
   */
  authGuard?: CanActivateLike;

  // ─── Security: SSRF protection for updateConfig(serverUrl) ──────────

  /**
   * Allow the `POST /smstunnel/update-config` route (and
   * `updateServerUrl()`) to change the SMSTunnel server URL at runtime.
   *
   * Defaults to `false`. When `false`, the server URL can only be set
   * server-side via `defaultServerUrl` / the storage adapter, and any
   * attempt to override it from a request body is rejected. This prevents
   * SSRF / API-key exfiltration via an attacker-controlled `serverUrl`.
   */
  allowServerUrlOverride?: boolean;

  /**
   * Hostnames (and their subdomains) that are accepted as an SMSTunnel
   * `serverUrl`. Only used when `allowServerUrlOverride` is `true`.
   * Defaults to `['smstunnel.io']`. Only `https://` URLs are ever accepted,
   * and URLs pointing at private/loopback hosts are always rejected.
   */
  serverUrlAllowlist?: string[];
}

/**
 * Minimal shape of a NestJS guard, accepted by `authGuard`.
 * Either a class with a no-arg constructor or an instance.
 */
export type CanActivateLike =
  | { canActivate(context: any): boolean | Promise<boolean> | any }
  | (new () => { canActivate(context: any): boolean | Promise<boolean> | any });

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
  pairingCode?: string;
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
    pairingCode: string;
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
