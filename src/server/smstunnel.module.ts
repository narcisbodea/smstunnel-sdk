import { DynamicModule, Module, Provider } from '@nestjs/common';
import { SmsTunnelService } from './smstunnel.service';
import { SmsTunnelController } from './smstunnel.controller';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import type {
  SmsTunnelModuleOptions,
  SmsTunnelModuleAsyncOptions,
} from './smstunnel.interfaces';

@Module({})
export class SmsTunnelModule {
  static forRoot(options: SmsTunnelModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: SMSTUNNEL_OPTIONS,
      useValue: options,
    };

    const controllers = [SmsTunnelController];
    if (!options.enableLegacyCallback) {
      // Legacy callback is always registered but won't match
      // if the consumer doesn't enable it - no-op
    }

    return {
      module: SmsTunnelModule,
      controllers,
      providers: [optionsProvider, SmsTunnelService],
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
      controllers: [SmsTunnelController],
      providers: [optionsProvider, SmsTunnelService],
      exports: [SmsTunnelService],
      global: false,
    };
  }
}
