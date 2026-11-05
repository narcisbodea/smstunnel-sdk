import { Inject, Injectable, Logger } from '@nestjs/common';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import { encryptPayload } from '../shared/e2e-crypto';
import { sealText } from '../shared/sealed-crypto';
import type { SealedCertificate } from '../shared/sealed-crypto';
import { failureOf, readBody } from '../shared/api-error';
import { pairingTokenOf } from '../shared/pairing-token';
import { describeForLog, isStoredToken, readLegacyCallback, readPairingCallback } from './smstunnel.callback';
import type { CallbackFields } from './smstunnel.callback';
import type {
  SmsTunnelConfig,
  SmsTunnelModuleOptions,
  SmsTunnelStatus,
  SendSmsResult,
  SendBulkResult,
  CreateTokenResult,
  PairingStatusResult,
  PairingCallbackBody,
  PairWithApiKeyResult,
  ExchangeKeysResult,
  SaasActivateResult,
  DeviceE2EStatus,
  DevicePublicKeyInfo,
  VerifyDeviceKeyResult,
  EnterpriseClientStatusResult,
  ReceivedSmsQuery,
  SmsStatusResult,
} from './smstunnel.interfaces';

/** The phones in a `GET /api/v1/devices` answer, which is `{ success, data: { devices, online, total } }`. */
function devicesOf(answer: any): any[] {
  const devices = answer?.data?.devices ?? answer?.devices;
  return Array.isArray(devices) ? devices : [];
}

/** The 2FA text: `template` with `{code}` replaced, the template followed by the code, or a default. */
function twoFaText(code: string, template?: string): string {
  if (!template) return `Your verification code: ${code}`;
  if (template.includes('{code}')) return template.split('{code}').join(code);
  return code && !template.includes(code) ? `${template} ${code}` : template;
}

@Injectable()
export class SmsTunnelService {
  private readonly logger = new Logger(SmsTunnelService.name);

  constructor(
    @Inject(SMSTUNNEL_OPTIONS)
    private readonly options: SmsTunnelModuleOptions,
  ) {}

  /**
   * Get current pairing status.
   */
  async getStatus(): Promise<SmsTunnelStatus> {
    const config = await this.options.storage.getConfig();
    return {
      paired: !!config.apiKey,
      serverUrl: config.serverUrl,
      deviceName: config.deviceName,
      e2eEnabled: !!config.devicePublicKey,
      deviceFingerprint: config.deviceFingerprint,
    };
  }

  /**
   * Create a pairing token on SMSTunnel server.
   * Uses Enterprise/SaaS flow when enterpriseApiKey is configured,
   * otherwise falls back to public-create flow.
   *
   * Starts a new pairing: once SMSTunnel has issued the token, it is stored and the stored API key is cleared
   * (`apiKey: ''`), so the phone's `pairing_completed` callback, which brings the new key, finds none. Until the
   * phone scans the QR code, `getStatus()` answers `paired: false`. Nothing is stored when the call fails.
   */
  async createPairingToken(): Promise<CreateTokenResult> {
    const config = await this.options.storage.getConfig();
    if (!config.serverUrl) {
      return { success: false, error: 'SMSTunnel server URL is not configured.' };
    }

    const serverUrl = config.serverUrl.replace(/\/$/, '');

    if (this.options.enterpriseApiKey) {
      return this.createPairingTokenEnterprise(serverUrl);
    }

    return this.createPairingTokenPublic(serverUrl);
  }

  /**
   * Public flow: POST /api/v1/pairing/public-create
   */
  private async createPairingTokenPublic(serverUrl: string): Promise<CreateTokenResult> {
    const prefix = 'smstunnel';
    const callbackUrl = `${this.options.callbackBaseUrl.replace(/\/$/, '')}/${prefix}/callback`;

    try {
      const res = await fetch(`${serverUrl}/api/v1/pairing/public-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'api',
          displayName: this.options.displayName || 'App',
          displayUrl: this.options.displayUrl || this.options.callbackBaseUrl,
          context: { callbackUrl },
        }),
      });

      if (!res.ok) {
        const body: any = await readBody(res);
        this.logger.warn(`SMSTunnel create token failed: ${res.status} ${JSON.stringify(body)}`);
        return {
          success: false,
          error: `SMSTunnel returned error: ${res.status}`,
          status: res.status,
          ...(typeof body?.code === 'string' ? { code: body.code } : {}),
        };
      }

      const data: any = await res.json();
      if (typeof data?.token !== 'string' || !data.token) {
        this.logger.warn('SMSTunnel create token: the answer has no pairing token');
        return { success: false, error: 'SMSTunnel answered without a pairing token.' };
      }

      // A new pairing: the callback that completes it is accepted only while no key is stored.
      await this.options.storage.updateConfig({ siteToken: data.token, apiKey: '' });

      this.logger.log('Pairing token created');

      return {
        success: true,
        token: data.token,
        pairingCode: data.pairingCode,
        qrData: data.qrData,
        expiresAt: data.expiresAt,
        pollUrl: data.pollUrl || `${serverUrl}/api/v1/pairing/${data.token}`,
      };
    } catch (err: any) {
      this.logger.error(`SMSTunnel create token error: ${err.message}`);
      return { success: false, error: `Could not connect to SMSTunnel: ${err.message}` };
    }
  }

  /**
   * Enterprise/SaaS flow: POST /api/v1/saas/activate
   * Creates sub-accounts under the Enterprise account.
   */
  private async createPairingTokenEnterprise(serverUrl: string): Promise<CreateTokenResult> {
    const prefix = 'smstunnel';
    const callbackUrl = `${this.options.callbackBaseUrl.replace(/\/$/, '')}/${prefix}/callback`;

    try {
      const res = await fetch(`${serverUrl}/api/v1/saas/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.options.enterpriseApiKey!,
        },
        body: JSON.stringify({
          clientName: this.options.displayName || 'App',
          externalId: this.options.externalId || 'default',
          callbackUrl,
        }),
      });

      if (!res.ok) {
        // 409 with code CONCURRENT_ACTIVATION or ALREADY_CONNECTED: another call for this externalId won.
        const body: any = await readBody(res);
        this.logger.warn(`SMSTunnel SaaS activate failed: ${res.status} ${JSON.stringify(body)}`);
        return {
          success: false,
          error: `SMSTunnel returned error: ${res.status}`,
          status: res.status,
          ...(typeof body?.code === 'string' ? { code: body.code } : {}),
        };
      }

      const data: SaasActivateResult = await res.json();

      if (!data.success || !data.activation) {
        return { success: false, error: data.error || 'SaaS activation failed' };
      }

      // The phone pairs with the token inside the QR code: it is the one the pairing_completed callback
      // carries and the one pairing status answers to. `activation.token` is only an older reference.
      const pairingToken = pairingTokenOf(data.activation.qrData) ?? data.activation.token;
      if (typeof pairingToken !== 'string' || !pairingToken) {
        this.logger.warn('SMSTunnel SaaS activate: the answer has no pairing token');
        return { success: false, error: 'SMSTunnel answered without a pairing token.' };
      }

      // A new pairing, as in the public flow: the stored key is cleared, and the activation's key (`data.apiKey`) is
      // not kept. The key this app sends with arrives in the phone's pairing_completed callback.
      await this.options.storage.updateConfig({ siteToken: pairingToken, apiKey: '' });

      this.logger.log(`SaaS pairing token created (isNew: ${data.isNew})`);

      return {
        success: true,
        token: pairingToken,
        pairingCode: data.activation.pairingCode,
        qrData: data.activation.qrData,
        expiresAt: data.activation.expiresAt,
        pollUrl: `${serverUrl}/api/v1/pairing/${pairingToken}`,
      };
    } catch (err: any) {
      this.logger.error(`SMSTunnel SaaS activate error: ${err.message}`);
      return { success: false, error: `Could not connect to SMSTunnel: ${err.message}` };
    }
  }

  /**
   * Check pairing status by polling SMSTunnel.
   */
  async getPairingStatus(token: string): Promise<PairingStatusResult> {
    const config = await this.options.storage.getConfig();
    if (!config.serverUrl) {
      return { status: 'error', error: 'SMSTunnel server URL not configured' };
    }

    const serverUrl = config.serverUrl.replace(/\/$/, '');

    try {
      // The token comes from a public route: encoded, it can only ever name a token.
      const res = await fetch(`${serverUrl}/api/v1/pairing/${encodeURIComponent(String(token))}`);
      if (!res.ok) {
        return { status: 'expired' };
      }
      return (await res.json()) as PairingStatusResult;
    } catch {
      return { status: 'error', error: 'Could not contact SMSTunnel' };
    }
  }

  /**
   * Handle the `pairing_completed` callback SMSTunnel posts when a phone scans this app's QR code. It is a public
   * route, so the body may come from anyone. It is accepted, and its key stored, only when:
   * - `event` is `pairing_completed`, `token` and `apiKey` are strings of visible characters (16 to 512), and
   *   `deviceId` (up to 128) and `deviceName` (up to 256) are strings when present;
   * - a token is stored (`createPairingToken()` stores it) and the posted one is that token, compared in constant time;
   * - no API key is stored yet: `createPairingToken()` clears it, so a real pairing finds none, and a token can't be
   *   used again once its phone is paired.
   *
   * @returns `true` when the key was stored; `false` when the callback was refused (nothing is stored, and the reason
   *   is logged without the token or the key).
   */
  async handlePairingCallback(body: PairingCallbackBody): Promise<boolean> {
    const reading = readPairingCallback(body);
    if (!reading.ok) {
      this.logger.warn(`Pairing callback refused: ${reading.reason}.`);
      return false;
    }
    return this.completePairing('Pairing callback', reading.fields, 'Android Phone');
  }

  /**
   * Handle the older WordPress-style callback (`{ site_token, api_key, device_name }`), with the same rules as
   * {@link handlePairingCallback}: `siteToken` must be the stored token and no API key may be stored yet.
   */
  async handleLegacyCallback(
    siteToken: string,
    apiKey: string,
    deviceName?: string,
  ): Promise<boolean> {
    const reading = readLegacyCallback(siteToken, apiKey, deviceName);
    if (!reading.ok) {
      this.logger.warn(`Legacy callback refused: ${reading.reason}.`);
      return false;
    }
    return this.completePairing('Legacy callback', reading.fields);
  }

  /** Stores the callback's key when this app is waiting for exactly this pairing. */
  private async completePairing(
    label: string,
    fields: CallbackFields,
    defaultDeviceName?: string,
  ): Promise<boolean> {
    const config = await this.options.storage.getConfig();

    if (!isStoredToken(config.siteToken, fields.token)) {
      this.logger.warn(
        `${label} refused: ${
          config.siteToken
            ? 'the token is not the one this app is waiting for'
            : 'this app is not waiting for a pairing (no token is stored)'
        }.`,
      );
      return false;
    }
    if (config.apiKey) {
      this.logger.warn(
        `${label} refused: this app already has an API key. To link another phone, unpair or create a new QR code first.`,
      );
      return false;
    }

    const update: Partial<SmsTunnelConfig> = { apiKey: fields.apiKey };
    const deviceName = fields.deviceName ?? defaultDeviceName;
    if (deviceName) update.deviceName = deviceName;
    if (fields.deviceId) update.deviceId = fields.deviceId;
    await this.options.storage.updateConfig(update);

    this.logger.log(`SMSTunnel paired! Device: ${describeForLog(deviceName ?? 'unknown', 80)}`);

    // Auto-exchange keys after pairing
    if (fields.deviceId) {
      this.exchangeKeys().catch((err) =>
        this.logger.warn(`Auto key exchange failed: ${err.message}`),
      );
    }

    return true;
  }

  /**
   * Pair using an API key directly (alternative to QR).
   * Validates the key by calling /api/v1/devices, then saves it.
   */
  async pairWithApiKey(apiKey: string): Promise<PairWithApiKeyResult> {
    const config = await this.options.storage.getConfig();
    if (!config.serverUrl) {
      return { success: false, error: 'SMSTunnel server URL is not configured.' };
    }

    const serverUrl = config.serverUrl.replace(/\/$/, '');

    try {
      const res = await fetch(`${serverUrl}/api/v1/devices`, {
        headers: { 'X-API-Key': apiKey },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: 'API key invalid or expired.' };
        }
        return { success: false, error: `SMSTunnel returned error: ${res.status}` };
      }

      const device = devicesOf(await res.json())[0];
      const deviceName = device?.name || 'Android Phone';
      const deviceId = device?.id || device?._id ? String(device.id || device._id) : undefined;

      const update: Record<string, any> = { apiKey, deviceName };
      if (deviceId) update.deviceId = deviceId;
      await this.options.storage.updateConfig(update);

      this.logger.log(`Paired via API key. Device: ${deviceName}`);

      // Auto-exchange keys
      if (deviceId) {
        this.exchangeKeys().catch((err) =>
          this.logger.warn(`Auto key exchange failed: ${err.message}`),
        );
      }

      return { success: true, deviceName };
    } catch (err: any) {
      this.logger.error(`Pair with API key error: ${err.message}`);
      return { success: false, error: `Could not connect to SMSTunnel: ${err.message}` };
    }
  }

  /**
   * Send SMS via SMSTunnel API.
   */
  async sendSms(to: string, message: string): Promise<SendSmsResult> {
    const config = await this.options.storage.getConfig();

    if (!config.apiKey) {
      return {
        success: false,
        error: 'SMSTunnel is not configured. Pair a device first.',
      };
    }

    if (!config.serverUrl) {
      return {
        success: false,
        error: 'SMSTunnel server URL is not configured.',
      };
    }

    const serverUrl = config.serverUrl.replace(/\/$/, '');

    try {
      const res = await fetch(`${serverUrl}/api/v1/sms/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify({ to, message }),
      });

      const data: any = await readBody(res);

      if (res.ok && data?.success) {
        this.logger.log(`SMS sent via SMSTunnel: ${data.messageId}`);
        return {
          success: true,
          messageId: data.messageId,
          ...(data.queued ? { queued: true } : {}),
          // `branded` and today's `remaining` allowance, as SMSTunnel answered them.
          ...(data.data ? { data: data.data } : {}),
        };
      }

      return failureOf(res.status, data);
    } catch (err: any) {
      this.logger.error(`SMS send error: ${err.message}`);
      return { success: false, error: `Could not send SMS: ${err.message}` };
    }
  }

  /**
   * Unpair - clear saved API key and device info.
   */
  async unpair(): Promise<void> {
    await this.options.storage.clearConfig();
    this.logger.log('SMSTunnel unpaired');
  }

  /**
   * Update server URL in config.
   *
   * SSRF-hardened: the supplied URL must be https, must resolve to a host on
   * the configured allowlist (default: smstunnel.io and subdomains), and must
   * not point at a private/loopback address. Runtime override is disabled
   * unless the consumer explicitly opts in via `allowServerUrlOverride`.
   * On any violation the value is rejected and NOT persisted.
   */
  async updateServerUrl(serverUrl: string): Promise<void> {
    const validated = this.validateServerUrl(serverUrl);
    await this.options.storage.updateConfig({ serverUrl: validated });
  }

  /**
   * Validate and normalize a server URL supplied at runtime.
   * Throws if the URL is not allowed. Returns the normalized URL
   * (no trailing slash) on success.
   */
  private validateServerUrl(rawUrl: string): string {
    if (this.options.allowServerUrlOverride !== true) {
      throw new Error(
        'SMSTunnel: runtime serverUrl override is disabled. ' +
          'Configure the server URL server-side (storage adapter) or set ' +
          'allowServerUrlOverride: true in SmsTunnelModule.forRoot().',
      );
    }

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      throw new Error('SMSTunnel: serverUrl is required.');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error(`SMSTunnel: invalid serverUrl: ${rawUrl}`);
    }

    // Only https is ever accepted (prevents downgrade + cleartext key leak).
    if (parsed.protocol !== 'https:') {
      throw new Error('SMSTunnel: serverUrl must use https://');
    }

    const host = parsed.hostname.toLowerCase();

    // Reject private / loopback / link-local / metadata hosts.
    if (this.isPrivateHost(host)) {
      throw new Error(
        `SMSTunnel: serverUrl host is not allowed (private/loopback): ${host}`,
      );
    }

    // Host must match the allowlist (exact host or a subdomain of it).
    const allowlist = (
      this.options.serverUrlAllowlist && this.options.serverUrlAllowlist.length
        ? this.options.serverUrlAllowlist
        : ['smstunnel.io']
    ).map((h) => h.toLowerCase().replace(/^\.+/, ''));

    const allowed = allowlist.some(
      (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`),
    );
    if (!allowed) {
      throw new Error(
        `SMSTunnel: serverUrl host "${host}" is not in the allowlist (${allowlist.join(', ')}).`,
      );
    }

    // Normalize: strip trailing slash from the origin + path.
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  }

  /**
   * Returns true for hosts that should never be used as a server URL:
   * localhost, loopback, RFC1918 / unique-local ranges, link-local and the
   * cloud metadata address.
   */
  private isPrivateHost(host: string): boolean {
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    ) {
      return true;
    }

    // IPv6 literals may arrive bracket-stripped from URL.hostname.
    if (host.includes(':')) {
      // ::1 handled above; treat any other IPv6 literal as private to be safe
      // (the allowlist is hostname-based, not IP-based).
      return true;
    }

    // IPv4 literal?
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const o = m.slice(1).map((n) => parseInt(n, 10));
      if (o.some((n) => n > 255)) return true; // malformed -> reject
      const [a, b] = o;
      if (a === 10) return true; // 10.0.0.0/8
      if (a === 127) return true; // loopback
      if (a === 0) return true; // "this" network
      if (a === 169 && b === 254) return true; // link-local + metadata 169.254.169.254
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; // 192.168.0.0/16
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
      return false;
    }

    return false;
  }

  // ─── Extended SMS endpoints ────────────────────────

  /**
   * Send a 2FA text via SMSTunnel API (counts against the 2FA quota).
   *
   * The text is `template` with `{code}` replaced (e.g. `'Shop: {code} is your code'`), the template followed
   * by the code when it has no `{code}`, or `Your verification code: <code>` without a template. SMSTunnel
   * refuses a 2FA text that contains no code.
   */
  async send2fa(to: string, code: string, template?: string): Promise<SendSmsResult> {
    return this.apiPost('/api/v1/sms/send-2fa', { to, message: twoFaText(code, template) });
  }

  /**
   * Send texts to several numbers. SMSTunnel takes one text for up to 100 numbers per request, so the texts
   * are grouped by wording: one request per distinct text (and per 100 numbers). Requests are rate-limited
   * (30 a minute), so many different wordings are better sent one by one with `sendSms`. The phone has to be
   * online.
   *
   * @param messages `[{ to, message }]`, or the numbers when `message` is given.
   * @returns one result per text, in your order, with its `messageId` or `error`.
   */
  async sendBulk(
    messages: Array<{ to: string; message: string }> | string[],
    message?: string,
  ): Promise<SendBulkResult> {
    const texts = (Array.isArray(messages) ? messages : []).map((item: any) =>
      typeof item === 'string' ? { to: item, message: message ?? '' } : { to: item?.to, message: item?.message },
    );
    if (texts.length === 0) {
      return { success: false, results: [], error: 'No texts to send.' };
    }

    const results: SendBulkResult['results'] = texts.map((text) => ({ to: text.to }));
    const byWording = new Map<string, number[]>();
    texts.forEach((text, index) => {
      byWording.set(text.message, [...(byWording.get(text.message) ?? []), index]);
    });

    for (const [wording, indexes] of byWording) {
      for (let start = 0; start < indexes.length; start += 100) {
        const chunk = indexes.slice(start, start + 100);
        const res = await this.apiPost('/api/v1/sms/send-bulk', {
          to: chunk.map((index) => texts[index].to),
          message: wording,
        });
        const ids: unknown = res?.data?.messageIds;
        if (res?.success && Array.isArray(ids) && ids.length === chunk.length) {
          chunk.forEach((index, position) => (results[index].messageId = String(ids[position])));
        } else {
          chunk.forEach((index) => (results[index].error = res?.error || 'SMSTunnel returned an error'));
        }
      }
    }

    const failed = results.filter((result) => result.error).length;
    if (failed === 0) return { success: true, results };
    return {
      success: false,
      results,
      error: failed === results.length ? results[0].error! : `${failed} of ${results.length} texts were not sent.`,
    };
  }

  /**
   * Get SMS delivery status (needs `sms:read`). `data.deliveryStatus` has the real state; an unconfirmed
   * text shows as `status: 'failed'` with `unconfirmed: true`.
   */
  async getSmsStatus(messageId: string): Promise<SmsStatusResult> {
    return this.apiGet(`/api/v1/sms/status/${encodeURIComponent(messageId)}`);
  }

  /**
   * Get received SMS (inbox). Needs a key allowed to read received texts: keys made by QR pairing never are,
   * so this usually answers `{ success: false, status: 403, code: 'PERMISSION_REQUIRED' }` unless you paired
   * with such a key through `pairWithApiKey()`.
   */
  async getReceivedSms(query?: ReceivedSmsQuery): Promise<any> {
    const params = new URLSearchParams();
    for (const name of ['limit', 'page', 'since', 'phone', 'deviceId'] as const) {
      const value = query?.[name];
      if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
    }
    const qs = params.toString();
    return this.apiGet(`/api/v1/sms/received${qs ? `?${qs}` : ''}`);
  }

  // ─── Devices & Account ─────────────────────────────

  /**
   * List paired devices.
   */
  async getDevices(): Promise<any> {
    return this.apiGet('/api/v1/devices');
  }

  /**
   * Get account usage stats.
   */
  async getUsage(): Promise<any> {
    return this.apiGet('/api/v1/account/usage');
  }

  // ─── E2E Encryption ──────────────────────────────

  /**
   * Exchange encryption keys with the paired device.
   * Fetches the device's public key from SMSTunnel server and stores it locally.
   * Called automatically after pairing, or manually via POST /smstunnel/exchange-keys.
   */
  async exchangeKeys(): Promise<ExchangeKeysResult> {
    const config = await this.options.storage.getConfig();
    if (!config.apiKey || !config.serverUrl) {
      return { success: false, error: 'SMSTunnel is not configured.' };
    }

    try {
      const resolved = await this.resolveDeviceId();
      if (!resolved.deviceId) {
        return { success: false, error: resolved.error || 'No paired device found.' };
      }
      const deviceId = resolved.deviceId;
      const path = `/api/v1/devices/${encodeURIComponent(deviceId)}`;

      // The key, then its fingerprint. SMSTunnel answers 400 for a phone without encryption.
      const key = await this.apiGet(`${path}/public-key`);
      if (!key?.success || !key.data?.publicKey) {
        return {
          success: false,
          error:
            key?.status === 400
              ? 'Device has no public key. Enable encryption in SMSTunnel app on the phone.'
              : `Could not fetch the device key: ${key?.error || 'no key'}`,
        };
      }
      const status = await this.apiGet(`${path}/e2e-status`);
      const fingerprint: string | undefined = status?.data?.publicKeyFingerprint;

      // Capability negotiation: v2 (hybrid) only for a phone that reports reading it. The API-key routes don't
      // report it yet, so a version is kept only when one is reported; otherwise 1 (v1-only), the safe default.
      const reported = status?.data?.e2eVersion ?? key.data.e2eVersion;
      await this.options.storage.updateConfig({
        deviceId,
        devicePublicKey: key.data.publicKey,
        ...(fingerprint ? { deviceFingerprint: fingerprint } : {}),
        deviceName: key.data.deviceName || config.deviceName,
        deviceE2eVersion: typeof reported === 'number' ? reported : config.deviceE2eVersion ?? 1,
      });

      this.logger.log(`E2E keys exchanged. Fingerprint: ${fingerprint}`);
      return {
        success: true,
        fingerprint,
        deviceName: key.data.deviceName,
      };
    } catch (err: any) {
      this.logger.error(`Key exchange error: ${err.message}`);
      return { success: false, error: `Key exchange failed: ${err.message}` };
    }
  }

  /**
   * Get E2E encryption status for a device (the paired one when `deviceId` is left out).
   */
  async getDeviceE2EStatus(
    deviceId?: string,
  ): Promise<{ success: boolean; data?: DeviceE2EStatus; error?: string }> {
    const id = deviceId || (await this.options.storage.getConfig()).deviceId;
    if (!id) return { success: false, error: 'No paired device.' };
    return this.apiGet(`/api/v1/devices/${encodeURIComponent(id)}/e2e-status`);
  }

  /**
   * Get a device's public key for E2E encryption (the paired one when `deviceId` is left out).
   */
  async getDevicePublicKey(
    deviceId?: string,
  ): Promise<{ success: boolean; data?: DevicePublicKeyInfo; error?: string }> {
    const id = deviceId || (await this.options.storage.getConfig()).deviceId;
    if (!id) return { success: false, error: 'No paired device.' };
    return this.apiGet(`/api/v1/devices/${encodeURIComponent(id)}/public-key`);
  }

  /**
   * Verify that a stored fingerprint matches the device's current key. A different one means the app was
   * reinstalled and the phone has to be paired again.
   */
  async verifyDeviceKey(deviceId: string, storedFingerprint: string): Promise<VerifyDeviceKeyResult> {
    const res = await this.getDeviceE2EStatus(deviceId);
    const status = res.success ? res.data : undefined;
    if (!status?.hasPublicKey || !status.publicKeyFingerprint) {
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
   * Send encrypted SMS via SMSTunnel API.
   * The payload is encrypted client-side with the device's RSA public key.
   *
   * Give `to` as well on every plan: the number stays visible to SMSTunnel and only the phone can read
   * the words. Leaving it out, and sealed texts, are Maximum privacy (Professional and Enterprise plans).
   */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
    to?: string,
  ): Promise<SendSmsResult> {
    return this.apiPost('/api/v1/sms/send', {
      ...(to !== undefined ? { to } : {}),
      encrypted: true,
      encryptedPayload,
      deviceId,
      is2FA,
    });
  }

  /**
   * Maximum privacy: seals the number and the text with your private certificate and sends the packet
   * without `to`. Only your software and the phone holding the certificate can read either.
   */
  async sendSealedSms(
    to: string,
    message: string,
    certificate: SealedCertificate,
    is2FA: boolean = false,
  ): Promise<SendSmsResult> {
    const { deviceId } = await this.resolveDeviceId();
    if (!deviceId) {
      return { success: false, error: 'No paired device. Pair and exchange keys first.' };
    }
    return this.apiPost('/api/v1/sms/send', {
      encrypted: true,
      encryptedPayload: sealText(certificate, { to, message }),
      deviceId,
      is2FA,
    });
  }

  /**
   * Encrypt a payload with the stored device public key, producing the
   * `encryptedPayload` transport string.
   *
   * Format gating (so old phones never break): the v2 hybrid format is used
   * ONLY when `forRoot({ e2eHybrid: true })` AND the stored
   * `deviceE2eVersion >= 2` (advertised by the device during key exchange).
   * Otherwise it falls back to v1 (RSA PKCS#1 v1.5). If no device public key is
   * stored yet, returns `null` — call `exchangeKeys()` first.
   *
   * @param payload object (JSON-stringified) or pre-serialized JSON string.
   */
  async encrypt(payload: string | Record<string, any>): Promise<string | null> {
    const config = await this.options.storage.getConfig();
    if (!config.devicePublicKey) {
      this.logger.warn('encrypt() called but no device public key is stored. Run exchangeKeys() first.');
      return null;
    }

    const payloadJson =
      typeof payload === 'string' ? payload : JSON.stringify(payload);

    return encryptPayload(payloadJson, config.devicePublicKey, {
      e2eHybrid: this.options.e2eHybrid === true,
      deviceE2eVersion: config.deviceE2eVersion,
    });
  }

  /**
   * Convenience: encrypt `{ to, message }` with the gated format and send it as
   * an encrypted SMS in one call. Exchanges keys first when none are stored yet.
   */
  async encryptAndSendSms(
    to: string,
    message: string,
    is2FA: boolean = false,
  ): Promise<SendSmsResult> {
    let config = await this.options.storage.getConfig();
    if (config.apiKey && (!config.deviceId || !config.devicePublicKey)) {
      await this.exchangeKeys();
      config = await this.options.storage.getConfig();
    }
    if (!config.deviceId) {
      return { success: false, error: 'No paired device. Pair and exchange keys first.' };
    }

    const encryptedPayload = await this.encrypt({ to, message });
    if (!encryptedPayload) {
      return {
        success: false,
        error: 'Device has no public key. Enable encryption in the SMSTunnel app and run exchangeKeys().',
      };
    }

    return this.sendEncryptedSms(encryptedPayload, config.deviceId, is2FA, to);
  }

  /**
   * @deprecated SMSTunnel lists pairings only for a dashboard sign-in, so with the stored API key this answers
   * `{ success: false, status: 401 }`. `getStatus()` tells whether this app is paired, `getDevices()` which
   * phones it can use.
   */
  async getPairings(): Promise<any> {
    return this.apiGet('/api/v1/pairings');
  }

  // ─── Enterprise ────────────────────────────────────

  /**
   * Enterprise mode: whether the client's phone has linked, and whether it is online.
   * Uses `enterpriseApiKey` and the configured `externalId` (or the one given).
   *
   * @returns `activation` is missing when the client has no pending or linked activation.
   */
  async getEnterpriseClientStatus(externalId?: string): Promise<EnterpriseClientStatusResult> {
    const id = externalId || this.options.externalId;
    if (!this.options.enterpriseApiKey || !id) {
      return { success: false, error: 'Enterprise mode needs enterpriseApiKey and externalId.' };
    }
    const config = await this.options.storage.getConfig();
    if (!config.serverUrl) {
      return { success: false, error: 'SMSTunnel server URL is not configured.' };
    }
    return this.request(config.serverUrl, this.options.enterpriseApiKey, 'GET', `/api/v1/saas/client/${encodeURIComponent(id)}`);
  }

  // ─── Internal helpers ──────────────────────────────

  /** The stored phone, or the first phone of the key's account (then stored). */
  private async resolveDeviceId(): Promise<{ deviceId?: string; error?: string }> {
    const config = await this.options.storage.getConfig();
    if (config.deviceId) return { deviceId: config.deviceId };
    const list = await this.apiGet('/api/v1/devices');
    if (!list?.success) {
      return { error: `Could not list devices: ${list?.status ?? ''} ${list?.error ?? ''}`.trim() };
    }
    const first = devicesOf(list)[0];
    const deviceId = first?.id || first?._id ? String(first.id || first._id) : undefined;
    if (!deviceId) return { error: 'No paired device found.' };
    await this.options.storage.updateConfig({ deviceId });
    return { deviceId };
  }

  /**
   * Advanced: an authenticated GET to any SMSTunnel API path, for a call this module doesn't wrap yet,
   * e.g. `apiGet('/api/v1/account/usage')`. Returns SMSTunnel's answer as it is, or on a failure
   * `{ success: false, status, error }` (plus `code` when SMSTunnel sends one).
   */
  async apiGet(path: string): Promise<any> {
    const config = await this.options.storage.getConfig();
    if (!config.apiKey || !config.serverUrl) {
      return { success: false, error: 'SMSTunnel is not configured.' };
    }
    return this.request(config.serverUrl, config.apiKey, 'GET', path);
  }

  /**
   * Advanced: an authenticated POST to any SMSTunnel API path, with the same answers as `apiGet`.
   * Prefer the typed methods (`sendSms`, `send2fa`, ...) when one fits.
   */
  async apiPost(path: string, body: any): Promise<any> {
    const config = await this.options.storage.getConfig();
    if (!config.apiKey || !config.serverUrl) {
      return { success: false, error: 'SMSTunnel is not configured.' };
    }
    return this.request(config.serverUrl, config.apiKey, 'POST', path, body);
  }

  /**
   * SMSTunnel's answer as it is when it succeeds. When it doesn't: its body plus `success: false`, the HTTP
   * `status`, and `error` in words, e.g. `{ success: false, status: 403, code: 'PERMISSION_REQUIRED', error }`.
   */
  private async request(
    serverUrl: string,
    apiKey: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<any> {
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'X-API-Key': apiKey,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await readBody(res);
      if (!res.ok || !data || typeof data !== 'object') {
        return failureOf(res.status, data);
      }
      return data;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
