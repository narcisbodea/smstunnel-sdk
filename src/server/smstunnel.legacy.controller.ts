import {
  Body,
  Controller,
  Inject,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SmsTunnelService } from './smstunnel.service';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import { SmsTunnelAuthGuard } from './smstunnel.guard';
import { SmsTunnelPublic } from './smstunnel.public.decorator';
import type { LegacyCallbackBody, SmsTunnelModuleOptions } from './smstunnel.interfaces';

/**
 * The older WordPress-style callback, `POST /wp-json/smstunnel/v1/setup-callback` with
 * `{ site_token, api_key, device_name }`. QR pairing doesn't use it: SMSTunnel posts to `/smstunnel/callback`.
 *
 * Off by default since 2.2.0: `forRoot()` mounts this controller only with `enableLegacyCallback: true`, and
 * `forRootAsync()` (whose options are known only at runtime) mounts it but answers 404 unless the options enable it.
 * When enabled it follows the same rules as the main callback (`SmsTunnelService.handleLegacyCallback`).
 */
@UseGuards(SmsTunnelAuthGuard)
@Controller()
export class SmsTunnelLegacyController {
  private readonly logger = new Logger(SmsTunnelLegacyController.name);

  constructor(
    // Explicit tokens: the package is built without decorator metadata (see SmsTunnelAuthGuard).
    @Inject(SmsTunnelService)
    private readonly smsTunnelService: SmsTunnelService,
    @Inject(SMSTUNNEL_OPTIONS)
    private readonly options: SmsTunnelModuleOptions,
  ) {}

  /**
   * WordPress-compatible legacy callback.
   * Route: POST /wp-json/smstunnel/v1/setup-callback
   */
  @SmsTunnelPublic()
  @Post('wp-json/smstunnel/v1/setup-callback')
  async setupCallbackWp(@Body() body: LegacyCallbackBody) {
    if (this.options.enableLegacyCallback !== true) {
      // As if the route weren't there.
      throw new NotFoundException();
    }
    this.logger.log('SMSTunnel legacy callback received');
    const fields: Partial<LegacyCallbackBody> =
      body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const success = await this.smsTunnelService.handleLegacyCallback(
      fields.site_token as string,
      fields.api_key as string,
      fields.device_name,
    );
    return { success };
  }
}
