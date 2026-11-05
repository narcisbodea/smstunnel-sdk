import { DynamicModule, Module, Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SmsTunnelService } from './smstunnel.service';
import { SmsTunnelController } from './smstunnel.controller';
import { SmsTunnelLegacyController } from './smstunnel.legacy.controller';
import { SmsTunnelAuthGuard } from './smstunnel.guard';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import type {
  SmsTunnelModuleOptions,
  SmsTunnelModuleAsyncOptions,
} from './smstunnel.interfaces';

/**
 * Works on NestJS 10, 11 and 12. Every class the module provides names its constructor's tokens with `@Inject()`,
 * so nothing depends on decorator metadata, neither in this package's build nor in your tsconfig.
 */
@Module({})
export class SmsTunnelModule {
  static forRoot(options: SmsTunnelModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: SMSTUNNEL_OPTIONS,
      useValue: options,
    };

    return {
      module: SmsTunnelModule,
      // The older WordPress-style callback route only when asked for (it was always mounted before 2.2.0).
      controllers:
        options?.enableLegacyCallback === true
          ? [SmsTunnelController, SmsTunnelLegacyController]
          : [SmsTunnelController],
      providers: [
        optionsProvider,
        SmsTunnelService,
        SmsTunnelAuthGuard,
        Reflector,
      ],
      exports: [SmsTunnelService],
      global: false,
    };
  }

  static forRootAsync(asyncOptions: SmsTunnelModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: SMSTUNNEL_OPTIONS,
      useFactory: asyncOptions.useFactory,
      inject: asyncOptions.inject || [],
    };

    return {
      module: SmsTunnelModule,
      // The options are known only once the factory has run, so the legacy route is mounted here and answers 404
      // unless they set enableLegacyCallback: true (see SmsTunnelLegacyController).
      controllers: [SmsTunnelController, SmsTunnelLegacyController],
      providers: [
        optionsProvider,
        SmsTunnelService,
        SmsTunnelAuthGuard,
        Reflector,
      ],
      exports: [SmsTunnelService],
      global: false,
    };
  }
}
