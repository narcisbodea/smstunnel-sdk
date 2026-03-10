import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Inject,
  Logger,
} from '@nestjs/common';
import { SmsTunnelService } from './smstunnel.service';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import type {
  SmsTunnelModuleOptions,
  PairingCallbackBody,
  LegacyCallbackBody,
} from './smstunnel.interfaces';

/**
 * Decorator to mark routes as public (no auth).
 * If you have your own @Public() decorator, the module re-exports
 * SMSTUNNEL_PUBLIC_PATHS so you can exclude them in your guard.
 */
function SmsTunnelPublic() {
  // We use Reflect metadata so consumers can detect public routes
  return (target: any, key: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata('isPublic', true, descriptor.value);
    return descriptor;
  };
}

@Controller()
export class SmsTunnelController {
  private readonly logger = new Logger(SmsTunnelController.name);
  private readonly prefix: string;

  constructor(
    private readonly smsTunnelService: SmsTunnelService,
    @Inject(SMSTUNNEL_OPTIONS)
    private readonly options: SmsTunnelModuleOptions,
  ) {
    this.prefix = 'smstunnel';
  }

  /**
   * Get current pairing status.
   * Route: GET /{prefix}/status
   */
  @Get('smstunnel/status')
  async getStatus() {
    return this.smsTunnelService.getStatus();
  }

  /**
   * Create a pairing token on SMSTunnel.
   * Route: POST /{prefix}/create-token
   */
  @Post('smstunnel/create-token')
  async createToken() {
    return this.smsTunnelService.createPairingToken();
  }

  /**
   * Proxy polling to SMSTunnel (avoids CORS issues).
   * This should be public (no auth) - just proxying SMSTunnel's endpoint.
   * Route: GET /{prefix}/pairing-status/:token
   */
  @SmsTunnelPublic()
  @Get('smstunnel/pairing-status/:token')
  async pairingStatus(@Param('token') token: string) {
    return this.smsTunnelService.getPairingStatus(token);
  }

  /**
   * Callback from SMSTunnel after pairing completes.
   * Route: POST /{prefix}/callback
   */
  @SmsTunnelPublic()
  @Post('smstunnel/callback')
  async pairingCallback(@Body() body: PairingCallbackBody) {
    this.logger.log(
      `SMSTunnel callback: event=${body.event}, token=${body.token?.substring(0, 8)}...`,
    );
    const success = await this.smsTunnelService.handlePairingCallback(body);
    return { success };
  }

  /**
   * WordPress-compatible legacy callback.
   * Route: POST /wp-json/smstunnel/v1/setup-callback
   */
  @SmsTunnelPublic()
  @Post('wp-json/smstunnel/v1/setup-callback')
  async setupCallbackWp(@Body() body: LegacyCallbackBody) {
    this.logger.log(`SMSTunnel legacy callback. Status: ${body.status || 'unknown'}`);
    const success = await this.smsTunnelService.handleLegacyCallback(
      body.site_token,
      body.api_key,
      body.device_name,
    );
    return { success };
  }

  /**
   * Unpair the connected device.
   * Route: POST /{prefix}/unpair
   */
  @Post('smstunnel/unpair')
  async unpair() {
    await this.smsTunnelService.unpair();
    return { success: true };
  }

  /**
   * Send an SMS via SMSTunnel.
   * Route: POST /{prefix}/send
   */
  @Post('smstunnel/send')
  async sendSms(@Body() body: { to: string; message: string }) {
    return this.smsTunnelService.sendSms(body.to, body.message);
  }

  /**
   * Update server URL configuration.
   * Route: POST /{prefix}/update-config
   */
  @Post('smstunnel/update-config')
  async updateConfig(@Body() body: { serverUrl: string }) {
    await this.smsTunnelService.updateServerUrl(body.serverUrl);
    return { success: true };
  }

  // ─── Extended SMS endpoints ────────────────────────

  /**
   * Send a 2FA SMS.
   * Route: POST /{prefix}/send-2fa
   */
  @Post('smstunnel/send-2fa')
  async send2fa(@Body() body: { to: string; code: string; template?: string }) {
    return this.smsTunnelService.send2fa(body.to, body.code, body.template);
  }

  /**
   * Send bulk SMS.
   * Route: POST /{prefix}/send-bulk
   */
  @Post('smstunnel/send-bulk')
  async sendBulk(@Body() body: { messages: Array<{ to: string; message: string }> }) {
    return this.smsTunnelService.sendBulk(body.messages);
  }

  /**
   * Get SMS delivery status.
   * Route: GET /{prefix}/sms-status/:messageId
   */
  @Get('smstunnel/sms-status/:messageId')
  async smsStatus(@Param('messageId') messageId: string) {
    return this.smsTunnelService.getSmsStatus(messageId);
  }

  /**
   * Get received SMS (inbox).
   * Route: GET /{prefix}/received
   */
  @Get('smstunnel/received')
  async receivedSms() {
    return this.smsTunnelService.getReceivedSms();
  }

  // ─── E2E Encryption ────────────────────────────────

  /**
   * Get E2E encryption status for a device.
   * Route: GET /{prefix}/e2e-status/:deviceId
   */
  @Get('smstunnel/e2e-status/:deviceId')
  async e2eStatus(@Param('deviceId') deviceId: string) {
    return this.smsTunnelService.getDeviceE2EStatus(deviceId);
  }

  /**
   * Get device public key for E2E encryption.
   * Route: GET /{prefix}/public-key/:deviceId
   */
  @Get('smstunnel/public-key/:deviceId')
  async publicKey(@Param('deviceId') deviceId: string) {
    return this.smsTunnelService.getDevicePublicKey(deviceId);
  }

  /**
   * Verify device key fingerprint.
   * Route: POST /{prefix}/verify-key
   */
  @Post('smstunnel/verify-key')
  async verifyKey(@Body() body: { deviceId: string; fingerprint: string }) {
    return this.smsTunnelService.verifyDeviceKey(body.deviceId, body.fingerprint);
  }

  /**
   * Send encrypted SMS.
   * Route: POST /{prefix}/send-encrypted
   */
  @Post('smstunnel/send-encrypted')
  async sendEncrypted(
    @Body() body: { encryptedPayload: string; deviceId: string; is2FA?: boolean },
  ) {
    return this.smsTunnelService.sendEncryptedSms(
      body.encryptedPayload,
      body.deviceId,
      body.is2FA,
    );
  }

  /**
   * List pairings.
   * Route: GET /{prefix}/pairings
   */
  @Get('smstunnel/pairings')
  async pairings() {
    return this.smsTunnelService.getPairings();
  }

  // ─── Devices & Account ─────────────────────────────

  /**
   * List paired devices.
   * Route: GET /{prefix}/devices
   */
  @Get('smstunnel/devices')
  async devices() {
    return this.smsTunnelService.getDevices();
  }

  /**
   * Get account usage stats.
   * Route: GET /{prefix}/usage
   */
  @Get('smstunnel/usage')
  async usage() {
    return this.smsTunnelService.getUsage();
  }
}
