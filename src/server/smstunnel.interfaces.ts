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
  /**
   * Mount the older WordPress-style callback, `POST /wp-json/smstunnel/v1/setup-callback`
   * (`{ site_token, api_key, device_name }`). QR pairing doesn't need it: SMSTunnel posts to `/smstunnel/callback`.
   *
   * Default `false` since 2.2.0 (the route was always mounted before): with `forRoot()` the route isn't mounted, with
   * `forRootAsync()` it answers 404. When enabled, it follows the same rules as `/smstunnel/callback`.
   */
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
  /** `true` when the phone was offline: it gets the text when it is back. */
  queued?: boolean;
  /** What went wrong, in words. */
  error?: string;
  /** On a failure: the HTTP status SMSTunnel answered with (403: permission or plan, 429: limit). */
  status?: number;
  /** On some failures: a stable code, e.g. `PERMISSION_REQUIRED`. */
  code?: string;
  /**
   * SMSTunnel's details: `branded` (a short free-plan line was added) and today's `remaining` allowance.
   * Present on success for `sendSms`, 2FA, encrypted and sealed texts.
   */
  data?: {
    messageId: string;
    branded: boolean;
    queued?: boolean;
    remaining: { clean: number; total: number | string };
  };
}

/** Where a text is now. `unconfirmed`: handed to the SIM, but the phone got no confirmation (final, never retried). */
export type SmsDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'unconfirmed';

/** The answer of `getSmsStatus()` (`GET /api/v1/sms/status/:id`, needs `sms:read`). */
export interface SmsStatusResult {
  success: boolean;
  data?: {
    id: string;
    /** For an encrypted text sent without `to`, the message id in brackets. */
    phoneNumber: string;
    /** An unconfirmed text shows here as `failed` with `unconfirmed: true`; `deliveryStatus` has the real state. */
    status: 'pending' | 'sent' | 'delivered' | 'failed';
    unconfirmed?: boolean;
    deliveryStatus?: SmsDeliveryStatus;
    sentAt?: string;
    deliveredAt?: string;
    errorMessage?: string | null;
  };
  /** On a failure: what went wrong, the HTTP status and, sometimes, a stable code. */
  error?: string;
  status?: number;
  code?: string;
}

export interface SendBulkResult {
  /** `true` only when every text went out. */
  success: boolean;
  /** One per text, in the order given. */
  results: Array<{ to: string; messageId?: string; error?: string }>;
  error?: string;
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

export interface CreateTokenResult {
  success: boolean;
  token?: string;
  /** Missing in Enterprise mode, where the phone links by the QR code only. */
  pairingCode?: string;
  qrData?: string;
  expiresAt?: string;
  pollUrl?: string;
  error?: string;
  /** On a failure: the HTTP status SMSTunnel answered with. */
  status?: number;
  /** On a 409 in Enterprise mode: `CONCURRENT_ACTIVATION` or `ALREADY_CONNECTED` (call again, or use the other result). */
  code?: string;
}

export interface EnterpriseClientStatusResult {
  success: boolean;
  /** Missing when the client has no pending or linked activation. */
  activation?: {
    id: string;
    status: 'pending' | 'connected' | 'expired' | 'cancelled';
    subAccountId?: string;
    deviceId?: string;
    connectedAt?: string;
    isOnline?: boolean;
  };
  error?: string;
  status?: number;
  code?: string;
}

export interface PairingStatusResult {
  status: string;
  displayName?: string;
  error?: string;
}

/**
 * What SMSTunnel posts to `/smstunnel/callback` when a phone scans the QR code. `handlePairingCallback()` checks every
 * field: the body of a public route may come from anyone.
 */
export interface PairingCallbackBody {
  event: string;
  token: string;
  apiKey: string;
  deviceId?: string;
  deviceName?: string;
  userId?: string;
  /** Sent too when the pairing was made with a `siteToken`. */
  site_token?: string;
}

export interface SaasActivateResult {
  success: boolean;
  isNew?: boolean;
  activation?: {
    id: string;
    subAccountId: string;
    /** An older reference. The phone links with the token inside `qrData`. */
    token: string;
    /** Not sent by SMSTunnel in this flow. */
    pairingCode?: string;
    qrData: string;
    qrDataRaw?: Record<string, any>;
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
