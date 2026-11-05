// SmsTunnelModule in NestJS (the devDependency, 11.x; the packed package is also run on 10.4, 11.2 and 12.3 before a
// release). 2.1.1 was built without decorator metadata: Nest 11/12 couldn't make SmsTunnelAuthGuard, Nest 10 made it
// without its Reflector and answered 500 on every route.
require('reflect-metadata');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { Module, HttpException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  SmsTunnelModule,
  SmsTunnelService,
  SmsTunnelController,
  SmsTunnelLegacyController,
  SmsTunnelAuthGuard,
} = require('../dist/server/index.js');
const { TOKEN, KEY, OTHER_KEY, memoryStorage } = require('./helpers.cjs');

const apps = [];
after(async () => {
  for (const app of apps) await app.close();
});

/** A Nest application context with the module imported the way an app does it. */
async function start(imported) {
  class AppModule {}
  Module({ imports: [imported] })(AppModule);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  apps.push(app);
  return app;
}

const options = (storage, extra = {}) => ({
  storage,
  callbackBaseUrl: 'https://app.test/api',
  authenticate: (req) => req?.headers?.authorization === 'Bearer ok',
  ...extra,
});

/** What a guard sees for a route of `Controller`. */
const contextFor = (Controller, method, request = {}) => ({
  getHandler: () => Controller.prototype[method],
  getClass: () => Controller,
  getType: () => 'http',
  switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
});

describe('SmsTunnelModule', () => {
  it('names every constructor dependency itself, so it needs no decorator metadata', () => {
    for (const Class of [SmsTunnelService, SmsTunnelAuthGuard, SmsTunnelController, SmsTunnelLegacyController]) {
      const declared = Reflect.getMetadata('self:paramtypes', Class) || [];
      assert.equal(declared.length, Class.length, `${Class.name}: ${declared.length} of ${Class.length} named`);
      assert.deepEqual(declared.map((dep) => dep.index).sort(), [...Array(Class.length).keys()], Class.name);
    }
  });

  it('forRoot() starts, and its controller, service and guard work', async () => {
    const storage = memoryStorage({ apiKey: KEY, deviceName: 'Pixel 8' });
    const app = await start(SmsTunnelModule.forRoot(options(storage)));

    const controller = app.get(SmsTunnelController);
    assert.deepEqual(await controller.getStatus(), {
      paired: true,
      serverUrl: storage.state.serverUrl,
      deviceName: 'Pixel 8',
      e2eEnabled: false,
      deviceFingerprint: undefined,
    });
    assert.ok(app.get(SmsTunnelService) instanceof SmsTunnelService);

    const guard = app.get(SmsTunnelAuthGuard);
    assert.equal(await guard.canActivate(contextFor(SmsTunnelController, 'pairingCallback')), true);
    assert.equal(await guard.canActivate(contextFor(SmsTunnelController, 'pairingStatus')), true);
    assert.equal(await guard.canActivate(contextFor(SmsTunnelController, 'getStatus')), false);
    assert.equal(
      await guard.canActivate(contextFor(SmsTunnelController, 'sendSms', { headers: { authorization: 'Bearer ok' } })),
      true,
    );
  });

  it('forRoot() without authenticate() blocks every route but the public ones', async () => {
    const app = await start(SmsTunnelModule.forRoot({ storage: memoryStorage(), callbackBaseUrl: '' }));
    const guard = app.get(SmsTunnelAuthGuard);
    assert.equal(await guard.canActivate(contextFor(SmsTunnelController, 'createToken', { headers: {} })), false);
    assert.equal(await guard.canActivate(contextFor(SmsTunnelController, 'pairingCallback')), true);
  });

  it('the callback route refuses a forged callback and never throws on a strange body', async () => {
    const storage = memoryStorage();
    const app = await start(SmsTunnelModule.forRoot(options(storage)));
    const controller = app.get(SmsTunnelController);
    for (const body of [
      { event: 'pairing_completed', token: TOKEN, apiKey: OTHER_KEY },
      { event: 'pairing_completed', token: 42, apiKey: OTHER_KEY },
      { event: 'pairing_completed', token: { $ne: null }, apiKey: [OTHER_KEY] },
      [],
      undefined,
    ]) {
      assert.deepEqual(await controller.pairingCallback(body), { success: false });
    }
    assert.deepEqual(storage.writes, []);
  });

  it('forRoot() mounts the legacy WordPress-style route only with enableLegacyCallback: true', async () => {
    assert.deepEqual(SmsTunnelModule.forRoot(options(memoryStorage())).controllers, [SmsTunnelController]);
    assert.deepEqual(
      SmsTunnelModule.forRoot(options(memoryStorage(), { enableLegacyCallback: false })).controllers,
      [SmsTunnelController],
    );
    const off = await start(SmsTunnelModule.forRoot(options(memoryStorage())));
    assert.throws(() => off.get(SmsTunnelLegacyController));

    const storage = memoryStorage({ siteToken: TOKEN });
    const on = await start(SmsTunnelModule.forRoot(options(storage, { enableLegacyCallback: true })));
    const legacy = on.get(SmsTunnelLegacyController);
    assert.deepEqual(await legacy.setupCallbackWp({ api_key: OTHER_KEY }), { success: false });
    assert.deepEqual(await legacy.setupCallbackWp({ site_token: TOKEN, api_key: KEY, device_name: 'Pixel 8' }), {
      success: true,
    });
    assert.equal(storage.state.apiKey, KEY);
    assert.deepEqual(await legacy.setupCallbackWp({ site_token: TOKEN, api_key: OTHER_KEY }), { success: false });
    assert.equal(storage.state.apiKey, KEY);
  });

  it('forRootAsync() starts; its legacy route answers 404 unless the options enable it', async () => {
    const off = await start(
      SmsTunnelModule.forRootAsync({ useFactory: async () => options(memoryStorage({ siteToken: TOKEN })) }),
    );
    await assert.rejects(off.get(SmsTunnelLegacyController).setupCallbackWp({ site_token: TOKEN, api_key: KEY }), (error) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 404);
      return true;
    });
    assert.deepEqual(await off.get(SmsTunnelController).getStatus().then((s) => s.paired), false);

    const storage = memoryStorage({ siteToken: TOKEN });
    const on = await start(
      SmsTunnelModule.forRootAsync({ useFactory: () => options(storage, { enableLegacyCallback: true }) }),
    );
    assert.deepEqual(await on.get(SmsTunnelLegacyController).setupCallbackWp({ site_token: TOKEN, api_key: KEY }), {
      success: true,
    });
  });
});
