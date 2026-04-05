import { Inject, Injectable, Logger } from '@nestjs/common';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
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
   */
  async updateServerUrl(serverUrl: string): Promise<void> {
    await this.options.storage.updateConfig({
      serverUrl: serverUrl.replace(/\/$/, ''),
    });
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
