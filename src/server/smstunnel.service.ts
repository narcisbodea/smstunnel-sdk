import { Inject, Injectable, Logger } from '@nestjs/common';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import { encryptPayload } from '../shared/e2e-crypto';
import type {
  SmsTunnelModuleOptions,
  SmsTunnelStatus,
  SendSmsResult,
  CreateTokenResult,
  PairingStatusResult,
  PairingCallbackBody,
  PairWithApiKeyResult,
  ExchangeKeysResult,
  SaasActivateResult,
} from './smstunnel.interfaces';

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
        const errText = await res.text();
        this.logger.warn(`SMSTunnel create token failed: ${res.status} ${errText}`);
        return { success: false, error: `SMSTunnel returned error: ${res.status}` };
      }

      const data: any = await res.json();

      await this.options.storage.updateConfig({ siteToken: data.token });

      this.logger.log(`Pairing token created: ${data.token?.substring(0, 12)}...`);

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
        const errText = await res.text();
        this.logger.warn(`SMSTunnel SaaS activate failed: ${res.status} ${errText}`);
        return { success: false, error: `SMSTunnel returned error: ${res.status}` };
      }

      const data: SaasActivateResult = await res.json();

      if (!data.success || !data.activation) {
        return { success: false, error: data.error || 'SaaS activation failed' };
      }

      // Save the activation token as siteToken
      const configUpdate: Record<string, any> = { siteToken: data.activation.token };

      // If the server returned an API key, save it too
      if (data.apiKey?.key) {
        configUpdate.apiKey = data.apiKey.key;
      }

      await this.options.storage.updateConfig(configUpdate);

      this.logger.log(
        `SaaS pairing token created: ${data.activation.token?.substring(0, 12)}... (isNew: ${data.isNew})`,
      );

      return {
        success: true,
        token: data.activation.token,
        pairingCode: data.activation.pairingCode,
        qrData: data.activation.qrData,
        expiresAt: data.activation.expiresAt,
        pollUrl: `${serverUrl}/api/v1/pairing/${data.activation.token}`,
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
      const res = await fetch(`${serverUrl}/api/v1/pairing/${token}`);
      if (!res.ok) {
        return { status: 'expired' };
      }
      return (await res.json()) as PairingStatusResult;
    } catch {
      return { status: 'error', error: 'Could not contact SMSTunnel' };
    }
  }

  /**
   * Handle callback from SMSTunnel after pairing completes.
   */
  async handlePairingCallback(body: PairingCallbackBody): Promise<boolean> {
    if (body.event !== 'pairing_completed') {
      this.logger.warn(`Unknown callback event: ${body.event}`);
      return false;
    }

    const config = await this.options.storage.getConfig();

    if (config.siteToken && config.siteToken !== body.token) {
      this.logger.warn(
        `Callback token mismatch: expected ${config.siteToken?.substring(0, 8)}, got ${body.token?.substring(0, 8)}`,
      );
      return false;
    }

    const update: Record<string, any> = {
      apiKey: body.apiKey,
      deviceName: body.deviceName || 'Android Phone',
    };
    if (body.deviceId) {
      update.deviceId = body.deviceId;
    }
    await this.options.storage.updateConfig(update);

    this.logger.log(
      `SMSTunnel paired! Device: ${body.deviceName}, API key: ${body.apiKey?.substring(0, 12)}...`,
    );

    // Auto-exchange keys after pairing
    if (body.deviceId) {
      this.exchangeKeys().catch((err) =>
        this.logger.warn(`Auto key exchange failed: ${err.message}`),
      );
    }

    return true;
  }

  /**
   * Handle legacy WordPress-compatible callback.
   */
  async handleLegacyCallback(
    siteToken: string,
    apiKey: string,
    deviceName?: string,
  ): Promise<boolean> {
    const config = await this.options.storage.getConfig();

    if (config.siteToken !== siteToken) {
      this.logger.warn('Legacy callback: site_token mismatch');
      return false;
    }

    const update: Partial<{ apiKey: string; deviceName: string }> = { apiKey };
    if (deviceName) update.deviceName = deviceName;

    await this.options.storage.updateConfig(update);
    this.logger.log(`SMSTunnel paired (legacy). Device: ${deviceName || 'unknown'}`);
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

      const data: any = await res.json();
      const devices = data?.devices || [];
      const device = devices[0];
      const deviceName = device?.name || 'Android Phone';
      const deviceId = device?.id || device?._id;

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

      const data: any = await res.json();

      if (data.success) {
        this.logger.log(`SMS sent via SMSTunnel: ${data.messageId} -> ${to}`);
        return { success: true, messageId: data.messageId };
      }

      return {
        success: false,
        error: data.error || data.message || 'SMSTunnel returned an error',
      };
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
   * Send 2FA SMS via SMSTunnel API.
   */
  async send2fa(to: string, code: string, template?: string): Promise<SendSmsResult> {
    return this.apiPost('/api/v1/sms/send-2fa', { to, code, template });
  }

  /**
   * Send bulk SMS via SMSTunnel API.
   */
  async sendBulk(
    messages: Array<{ to: string; message: string }>,
  ): Promise<{ success: boolean; results?: any[]; error?: string }> {
    return this.apiPost('/api/v1/sms/send-bulk', { messages });
  }

  /**
   * Get SMS delivery status.
   */
  async getSmsStatus(messageId: string): Promise<any> {
    return this.apiGet(`/api/v1/sms/status/${messageId}`);
  }

  /**
   * Get received SMS (inbox).
   */
  async getReceivedSms(): Promise<any> {
    return this.apiGet('/api/v1/sms/received');
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

    const serverUrl = config.serverUrl.replace(/\/$/, '');

    try {
      // Resolve deviceId if we don't have it
      let deviceId = config.deviceId;
      if (!deviceId) {
        const listRes = await fetch(`${serverUrl}/api/v1/devices`, {
          headers: { 'X-API-Key': config.apiKey },
        });
        if (!listRes.ok) {
          return { success: false, error: `Could not list devices: ${listRes.status}` };
        }
        const listData: any = await listRes.json();
        const devices = listData?.devices || [];
        if (devices.length === 0) {
          return { success: false, error: 'No paired device found.' };
        }
        deviceId = devices[0].id || devices[0]._id;
        await this.options.storage.updateConfig({ deviceId });
      }

      // Fetch device detail (includes publicKey)
      const res = await fetch(`${serverUrl}/api/v1/devices/${deviceId}`, {
        headers: { 'X-API-Key': config.apiKey },
      });

      if (!res.ok) {
        return { success: false, error: `Could not fetch device: ${res.status}` };
      }

      const device: any = await res.json();

      if (!device.publicKey) {
        return { success: false, error: 'Device has no public key. Enable encryption in SMSTunnel app on the phone.' };
      }

      await this.options.storage.updateConfig({
        deviceId,
        devicePublicKey: device.publicKey,
        deviceFingerprint: device.publicKeyFingerprint,
        deviceName: device.name || config.deviceName,
        // Capability negotiation: store the device's advertised E2E version so
        // the encryptor knows whether v2 (hybrid) is safe. Default 1 (v1-only).
        deviceE2eVersion:
          typeof device.e2eVersion === 'number' ? device.e2eVersion : 1,
      });

      this.logger.log(`E2E keys exchanged. Fingerprint: ${device.publicKeyFingerprint}`);
      return {
        success: true,
        fingerprint: device.publicKeyFingerprint,
        deviceName: device.name,
      };
    } catch (err: any) {
      this.logger.error(`Key exchange error: ${err.message}`);
      return { success: false, error: `Key exchange failed: ${err.message}` };
    }
  }

  /**
   * Send encrypted SMS via SMSTunnel API.
   * The payload is encrypted client-side with the device's RSA public key.
   */
  async sendEncryptedSms(
    encryptedPayload: string,
    deviceId: string,
    is2FA: boolean = false,
  ): Promise<SendSmsResult> {
    return this.apiPost('/api/v1/sms/send', {
      encrypted: true,
      encryptedPayload,
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
   * an encrypted SMS in one call. Requires keys to have been exchanged first.
   */
  async encryptAndSendSms(
    to: string,
    message: string,
    is2FA: boolean = false,
  ): Promise<SendSmsResult> {
    const config = await this.options.storage.getConfig();
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

    return this.sendEncryptedSms(encryptedPayload, config.deviceId, is2FA);
  }

  /**
   * List pairings for the authenticated user.
   */
  async getPairings(): Promise<any> {
    return this.apiGet('/api/v1/pairings');
  }

  // ─── Internal helpers ──────────────────────────────

  /** Make an authenticated GET request to SMSTunnel */
  private async apiGet(path: string): Promise<any> {
    const config = await this.options.storage.getConfig();
    if (!config.apiKey || !config.serverUrl) {
      return { success: false, error: 'SMSTunnel is not configured.' };
    }
    const serverUrl = config.serverUrl.replace(/\/$/, '');
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        headers: { 'X-API-Key': config.apiKey },
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Make an authenticated POST request to SMSTunnel */
  private async apiPost(path: string, body: any): Promise<any> {
    const config = await this.options.storage.getConfig();
    if (!config.apiKey || !config.serverUrl) {
      return { success: false, error: 'SMSTunnel is not configured.' };
    }
    const serverUrl = config.serverUrl.replace(/\/$/, '');
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
