import { DynamicModule, Module, Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SmsTunnelService } from './smstunnel.service';
import { SmsTunnelController } from './smstunnel.controller';
import { SmsTunnelAuthGuard } from './smstunnel.guard';
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

    return {
      module: SmsTunnelModule,
      controllers: [SmsTunnelController],
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
      controllers: [SmsTunnelController],
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
