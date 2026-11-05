// The ESM build (dist/server/index.mjs) starts in NestJS too: an ESM app (NestJS 12 is ESM) imports this one.
import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import common from '@nestjs/common';
import core from '@nestjs/core';
import { SmsTunnelModule, SmsTunnelController, SmsTunnelAuthGuard } from '../dist/server/index.mjs';

it('the ESM build of forRoot() starts and refuses a forged callback', async () => {
  const state = { serverUrl: 'https://smstunnel.test' };
  const storage = {
    getConfig: async () => ({ ...state }),
    updateConfig: async (partial) => Object.assign(state, partial),
    clearConfig: async () => {},
  };
  class AppModule {}
  common.Module({ imports: [SmsTunnelModule.forRoot({ storage, callbackBaseUrl: '', authenticate: () => true })] })(
    AppModule,
  );
  const app = await core.NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  try {
    const controller = app.get(SmsTunnelController);
    assert.deepEqual(
      await controller.pairingCallback({ event: 'pairing_completed', token: 'a'.repeat(64), apiKey: 'sk_' + 'live_' + 'f'.repeat(32) }),
      { success: false },
    );
    assert.ok(!state.apiKey);
    assert.ok(app.get(SmsTunnelAuthGuard));
  } finally {
    await app.close();
  }
});
