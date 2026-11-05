// The pairing callbacks (`handlePairingCallback`, `handleLegacyCallback`): the rules of 2.2.0, the real pairing
// flows, and the way a multi-tenant app calls the service.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { SmsTunnelService } = require('../dist/server/index.js');
const {
  fakeKey,
  TOKEN,
  KEY,
  OTHER_KEY,
  SERVER,
  memoryStorage,
  captureLogs,
  stubFetch,
  settle,
  qrDataFor,
} = require('./helpers.cjs');

const callback = (fields = {}) => ({ event: 'pairing_completed', token: TOKEN, apiKey: KEY, ...fields });
const serviceWith = (storage, extra = {}) =>
  new SmsTunnelService({ storage, callbackBaseUrl: 'https://app.test/api', displayName: 'Test App', ...extra });

let logs;
let net;
beforeEach(() => {
  logs = captureLogs();
  net = stubFetch(); // no route: any network call throws
});
afterEach(async () => {
  await settle();
  net.restore();
  logs.restore();
});

describe('a callback is refused', () => {
  it('when no token is stored (before any QR pairing, after pairing by API key, after unpairing)', async () => {
    for (const stored of [undefined, null, '']) {
      const storage = memoryStorage(stored === undefined ? {} : { siteToken: stored });
      const sdk = serviceWith(storage);
      assert.equal(await sdk.handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
      assert.deepEqual(storage.writes, []);
      assert.ok(!storage.state.apiKey);
    }
    // Paired with an API key (pair-with-key / env), then a callback arrives: the key stays.
    const byKey = memoryStorage({ apiKey: KEY });
    assert.equal(await serviceWith(byKey).handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
    assert.equal(byKey.state.apiKey, KEY);
    assert.match(logs.text(), /not waiting for a pairing/);
  });

  it('when the token is wrong', async () => {
    const storage = memoryStorage({ siteToken: TOKEN });
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('0') ? '1' : '0');
    assert.equal(await serviceWith(storage).handlePairingCallback(callback({ token: wrong })), false);
    assert.deepEqual(storage.writes, []);
    assert.match(logs.text(), /not the one this app is waiting for/);
  });

  it('when the token has a different length (and nothing throws)', async () => {
    const storage = memoryStorage({ siteToken: TOKEN });
    const sdk = serviceWith(storage);
    for (const token of [TOKEN.slice(0, 63), TOKEN + '0', TOKEN.slice(0, 16), TOKEN + TOKEN]) {
      assert.equal(await sdk.handlePairingCallback(callback({ token })), false, `length ${token.length}`);
    }
    assert.deepEqual(storage.writes, []);
  });

  it('when a field is not a string of sane length', async () => {
    const storage = memoryStorage({ siteToken: TOKEN });
    const sdk = serviceWith(storage);
    const bad = [
      ...[undefined, null, '', 12345678901234567890, { $ne: null }, [TOKEN], true].map((token) => ({ token })),
      { token: 'short-token' }, // under 16
      { token: 'x'.repeat(513) },
      { token: ` ${TOKEN}` },
      { token: `${TOKEN}\n` },
      ...[undefined, null, '', 42, { $ne: null }, [KEY], false].map((apiKey) => ({ apiKey })),
      { apiKey: 'sk_short' },
      { apiKey: `${KEY} ` },
      { apiKey: 'k'.repeat(513) },
      ...[42, { $gt: '' }, ['dev-1'], true, 'dev 1', 'd'.repeat(129)].map((deviceId) => ({ deviceId })),
      ...[42, { $gt: '' }, ['Pixel'], true, 'P'.repeat(257)].map((deviceName) => ({ deviceName })),
      ...[undefined, null, 'pairing_started', ['pairing_completed'], { $eq: 'pairing_completed' }].map((event) => ({ event })),
    ];
    for (const fields of bad) {
      assert.equal(await sdk.handlePairingCallback(callback(fields)), false, JSON.stringify(fields));
    }
    for (const body of [undefined, null, [], 'pairing_completed', 42]) {
      assert.equal(await sdk.handlePairingCallback(body), false, JSON.stringify(body));
    }
    assert.deepEqual(storage.writes, []);
  });

  it('when a key is already set, and the key stays', async () => {
    const storage = memoryStorage({ siteToken: TOKEN, apiKey: KEY, deviceName: 'Pixel 8' });
    assert.equal(await serviceWith(storage).handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
    assert.equal(storage.state.apiKey, KEY);
    assert.deepEqual(storage.writes, []);
    assert.match(logs.text(), /already has an API key/);
  });

  it('and the log never shows the token or the key', async () => {
    const storage = memoryStorage({ siteToken: TOKEN });
    const sdk = serviceWith(storage);
    await sdk.handlePairingCallback(callback({ token: TOKEN.replace(/^a/, 'b'), apiKey: OTHER_KEY }));
    await sdk.handlePairingCallback(callback({ token: 42 }));
    await sdk.handlePairingCallback(callback({ deviceId: 'dev-1', deviceName: 'Pixel\n8' }));
    await settle();
    const text = logs.text();
    for (const secret of [TOKEN, TOKEN.slice(0, 8), KEY, KEY.slice(0, 12), OTHER_KEY, OTHER_KEY.slice(0, 12)]) {
      assert.ok(!text.includes(secret), `log contains ${secret}`);
    }
    assert.ok(text.includes('Pixel 8'));
    assert.ok(logs.lines.every((line) => !/[\u0000-\u001f]/.test(line)), 'a control character reached the log');
  });
});

describe('the real pairing still works', () => {
  const publicCreate = () => ({
    'POST /api/v1/pairing/public-create': () => ({
      status: 201,
      body: { token: TOKEN, pairingCode: 'ABCD-1234', qrData: qrDataFor(TOKEN), expiresAt: '2026-11-06T09:00:00.000Z' },
    }),
    // The key exchange that follows a pairing: this phone has no encryption key.
    'GET /api/v1/devices/dev-1/public-key': () => ({ status: 400, body: { statusCode: 400, message: 'No public key' } }),
  });

  it('QR code, then the callback: the key is stored, and the same token can not be used again', async () => {
    net.restore();
    net = stubFetch(publicCreate());
    const storage = memoryStorage();
    const sdk = serviceWith(storage);

    const created = await sdk.createPairingToken();
    assert.equal(created.success, true);
    assert.equal(created.token, TOKEN);
    assert.equal(storage.state.siteToken, TOKEN);
    assert.equal(storage.state.apiKey, '');
    assert.equal((await sdk.getStatus()).paired, false);
    const sent = net.calls.find((call) => call.path === '/api/v1/pairing/public-create');
    assert.equal(JSON.parse(sent.body).context.callbackUrl, 'https://app.test/api/smstunnel/callback');

    assert.equal(await sdk.handlePairingCallback(callback({ deviceId: 'dev-1', deviceName: 'Pixel 8' })), true);
    assert.equal(storage.state.apiKey, KEY);
    assert.equal(storage.state.deviceName, 'Pixel 8');
    assert.equal(storage.state.deviceId, 'dev-1');
    assert.equal((await sdk.getStatus()).paired, true);
    await settle();

    assert.equal(await sdk.handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
    assert.equal(storage.state.apiKey, KEY);
  });

  it('pairing again: a new QR code clears the old key, and the new phone is accepted', async () => {
    net.restore();
    net = stubFetch(publicCreate());
    const storage = memoryStorage({ siteToken: 'f'.repeat(64), apiKey: OTHER_KEY, deviceName: 'Old phone' });
    const sdk = serviceWith(storage);

    assert.equal((await sdk.createPairingToken()).success, true);
    assert.equal(storage.state.apiKey, '');
    assert.equal(await sdk.handlePairingCallback(callback({ deviceName: 'New phone' })), true);
    assert.equal(storage.state.apiKey, KEY);
    assert.equal(storage.state.deviceName, 'New phone');
  });

  it('a failed QR code request stores nothing and keeps the key', async () => {
    net.restore();
    net = stubFetch({ 'POST /api/v1/pairing/public-create': () => ({ status: 503, body: { message: 'down' } }) });
    const storage = memoryStorage({ apiKey: KEY });
    const result = await serviceWith(storage).createPairingToken();
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.deepEqual(storage.writes, []);
    assert.equal(storage.state.apiKey, KEY);
  });

  it('a QR code answer without a token stores nothing', async () => {
    net.restore();
    net = stubFetch({ 'POST /api/v1/pairing/public-create': () => ({ status: 201, body: { pairingCode: 'X' } }) });
    const storage = memoryStorage({ apiKey: KEY });
    assert.equal((await serviceWith(storage).createPairingToken()).success, false);
    assert.deepEqual(storage.writes, []);
  });

  it('Enterprise: the token inside the QR code is stored, the activation key is not, and the callback brings the key', async () => {
    const enterpriseKey = fakeKey('e'.repeat(32));
    const activationKey = fakeKey('a'.repeat(32));
    net.restore();
    net = stubFetch({
      'POST /api/v1/saas/activate': () => ({
        status: 201,
        body: {
          success: true,
          isNew: true,
          activation: {
            id: 'act-1',
            subAccountId: 'sub-1',
            token: 'b'.repeat(64), // the older reference, not the one the phone pairs with
            qrData: qrDataFor(TOKEN),
            expiresAt: '2027-11-06T09:00:00.000Z',
          },
          apiKey: { id: 'key-1', key: activationKey, permissions: ['sms:send', 'sms:read'] },
        },
      }),
    });
    const storage = memoryStorage({ apiKey: OTHER_KEY });
    const sdk = serviceWith(storage, { enterpriseApiKey: enterpriseKey, externalId: 'tenant-42' });

    const created = await sdk.createPairingToken();
    assert.equal(created.success, true);
    assert.equal(created.token, TOKEN);
    assert.equal(storage.state.siteToken, TOKEN);
    assert.equal(storage.state.apiKey, '');
    assert.ok(!JSON.stringify(storage.writes).includes(activationKey), 'the activation key was stored');
    const activate = net.calls.find((call) => call.path === '/api/v1/saas/activate');
    assert.equal(activate.headers['X-API-Key'], enterpriseKey);
    assert.equal(JSON.parse(activate.body).externalId, 'tenant-42');

    assert.equal(await sdk.handlePairingCallback(callback({ deviceName: 'Clinic phone' })), true);
    assert.equal(storage.state.apiKey, KEY);
  });

  it('the pairing-status proxy keeps the token inside the path', async () => {
    net.restore();
    net = stubFetch({ 'GET /api/v1/pairing/..%2Fdevices': () => ({ body: { status: 'expired' } }) });
    await serviceWith(memoryStorage()).getPairingStatus('../devices');
    assert.equal(net.calls[0].url, `${SERVER}/api/v1/pairing/..%2Fdevices`);
  });
});

describe('the legacy callback follows the same rules', () => {
  it('refused without a stored token, with a wrong token, with a key already set, or with non-strings', async () => {
    assert.equal(await serviceWith(memoryStorage()).handleLegacyCallback(TOKEN, OTHER_KEY), false);
    // 2.1.1 accepted this one: nothing stored and no site_token sent.
    assert.equal(await serviceWith(memoryStorage()).handleLegacyCallback(undefined, OTHER_KEY), false);
    assert.equal(await serviceWith(memoryStorage({ siteToken: TOKEN })).handleLegacyCallback('c'.repeat(64), KEY), false);
    const paired = memoryStorage({ siteToken: TOKEN, apiKey: KEY });
    assert.equal(await serviceWith(paired).handleLegacyCallback(TOKEN, OTHER_KEY), false);
    assert.equal(paired.state.apiKey, KEY);
    for (const [token, key, name] of [[42, KEY], [TOKEN, { $ne: null }], [TOKEN, KEY, { x: 1 }], [[TOKEN], KEY]]) {
      assert.equal(await serviceWith(memoryStorage({ siteToken: TOKEN })).handleLegacyCallback(token, key, name), false);
    }
  });

  it('accepted for the stored token while no key is set', async () => {
    const storage = memoryStorage({ siteToken: TOKEN });
    assert.equal(await serviceWith(storage).handleLegacyCallback(TOKEN, KEY, 'Pixel 8'), true);
    assert.deepEqual(storage.writes, [{ apiKey: KEY, deviceName: 'Pixel 8' }]);
  });
});

// A multi-tenant app in production (SDK 2.0.0) builds a SmsTunnelService per tenant, without the module, with the
// storage below, and checks the callback itself before handing it to the SDK. The replica keeps its logic (its own
// createPairingToken also clears the key, and it keeps the token after pairing to poll the status); the database is
// a Map.
describe("a multi-tenant app's way of calling still works", () => {
  const ENTERPRISE_KEY = fakeKey('c'.repeat(32));

  /** Its storage: four fields in `smsSettings`; a key also sets status 'paired'. */
  class TenantStorage {
    constructor(db, id) {
      this.db = db;
      this.id = id;
    }
    async getConfig() {
      const s = this.db.get(this.id)?.smsSettings;
      return s ? { serverUrl: s.serverUrl, apiKey: s.apiKey, siteToken: s.siteToken, deviceName: s.deviceName } : {};
    }
    async updateConfig(partial) {
      const update = {};
      for (const field of ['serverUrl', 'apiKey', 'siteToken', 'deviceName']) {
        if (partial[field] !== undefined) update[field] = partial[field];
      }
      if (Object.keys(update).length === 0) return;
      if (partial.apiKey) Object.assign(update, { status: 'paired', pairedAt: new Date() });
      const doc = this.db.get(this.id) ?? { tenantId: this.id };
      doc.smsSettings = { ...(doc.smsSettings ?? {}), ...update };
      this.db.set(this.id, doc);
    }
    async clearConfig() {
      Object.assign(this.db.get(this.id).smsSettings, {
        apiKey: null,
        siteToken: null,
        deviceName: null,
        status: 'inactive',
        pairedAt: null,
      });
    }
  }

  /** Its service, the parts that pair a phone. */
  function tenantApp(db) {
    const sdkFor = async (id) => {
      const storage = new TenantStorage(db, id);
      if (!(await storage.getConfig()).serverUrl) await storage.updateConfig({ serverUrl: SERVER });
      return new SmsTunnelService({
        storage,
        callbackBaseUrl: 'https://api.tenants.test/v1',
        displayName: 'Tenant Test',
        displayUrl: 'https://api.tenants.test/v1',
        enterpriseApiKey: ENTERPRISE_KEY,
        externalId: id,
      });
    };
    return {
      async createPairingToken(id) {
        const result = await (await sdkFor(id)).createPairingToken();
        if (result.success && result.qrData) {
          const real = JSON.parse(Buffer.from(result.qrData, 'base64').toString('utf-8')).t || null;
          if (real && real !== result.token) result.token = real;
          // $set siteToken, $unset apiKey / status / pairedAt
          const s = db.get(id).smsSettings;
          s.siteToken = real || result.token;
          delete s.apiKey;
          delete s.status;
          delete s.pairedAt;
        }
        return result;
      },
      async handlePairingCallback(body) {
        const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
        const token = text(body?.token, 256);
        const apiKey = text(body?.apiKey, 256);
        const deviceName = text(body?.deviceName, 100);
        const deviceId = text(body?.deviceId, 100);
        if (body?.event !== 'pairing_completed') return false;
        if (token.length < 32 || !apiKey) return false;
        const found = [...db.values()].find((doc) => doc.smsSettings?.siteToken === token);
        if (!found) return false;
        if (found.smsSettings.apiKey) return false;
        const sdk = await sdkFor(found.tenantId);
        return sdk.handlePairingCallback({
          event: 'pairing_completed',
          token,
          apiKey,
          ...(deviceName && { deviceName }),
          ...(deviceId && { deviceId }),
        });
      },
      getPairingStatus: async (token) => {
        const found = [...db.values()].find((doc) => doc.smsSettings?.siteToken === token);
        return found ? (await sdkFor(found.tenantId)).getPairingStatus(token) : { status: 'error' };
      },
      unpair: async (id) => (await sdkFor(id)).unpair(),
    };
  }

  const activateAnswer = (token) => () => ({
    status: 201,
    body: {
      success: true,
      isNew: false,
      activation: { id: 'act', subAccountId: 'sub', token: 'b'.repeat(64), qrData: qrDataFor(token), expiresAt: '2027-01-01' },
      apiKey: { id: 'k', key: fakeKey('9'.repeat(32)), permissions: ['sms:send', 'sms:read'] },
    },
  });

  it('a tenant pairs, keeps its token for polling, and a reused token is refused', async () => {
    net.restore();
    net = stubFetch({
      'POST /api/v1/saas/activate': activateAnswer(TOKEN),
      [`GET /api/v1/pairing/${TOKEN}`]: () => ({ body: { status: 'completed', displayName: 'Tenant Test' } }),
    });
    const db = new Map([['tenant-1', { tenantId: 'tenant-1' }], ['tenant-2', { tenantId: 'tenant-2' }]]);
    const app = tenantApp(db);

    const created = await app.createPairingToken('tenant-1');
    assert.equal(created.success, true);
    assert.equal(created.token, TOKEN);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, undefined);

    // What the app's own tests send: deviceId 'dev-1', a 40-character key, a 64-character token.
    assert.equal(await app.handlePairingCallback(callback({ deviceName: 'My Phone', deviceId: 'dev-1' })), true);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, KEY);
    assert.equal(db.get('tenant-1').smsSettings.status, 'paired');
    assert.equal(db.get('tenant-1').smsSettings.deviceName, 'My Phone');
    assert.equal(db.get('tenant-1').smsSettings.siteToken, TOKEN);
    assert.equal(db.get('tenant-2').smsSettings?.apiKey, undefined);
    assert.equal((await app.getPairingStatus(TOKEN)).status, 'completed');
    await settle();

    // Reused token: the app refuses it, and so does the SDK when asked directly.
    assert.equal(await app.handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
    const direct = new SmsTunnelService({ storage: new TenantStorage(db, 'tenant-1'), callbackBaseUrl: '' });
    assert.equal(await direct.handlePairingCallback(callback({ apiKey: OTHER_KEY })), false);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, KEY);

    const text = logs.text();
    for (const secret of [KEY, OTHER_KEY, TOKEN]) assert.ok(!text.includes(secret));
  });

  it('a tenant pairs again with a new QR code, and an unpaired tenant refuses every callback', async () => {
    const second = 'd'.repeat(64);
    net.restore();
    net = stubFetch({ 'POST /api/v1/saas/activate': activateAnswer(TOKEN) });
    const db = new Map([['tenant-1', { tenantId: 'tenant-1' }]]);
    const app = tenantApp(db);
    await app.createPairingToken('tenant-1');
    assert.equal(await app.handlePairingCallback(callback()), true);

    net.restore();
    net = stubFetch({ 'POST /api/v1/saas/activate': activateAnswer(second) });
    await app.createPairingToken('tenant-1');
    assert.equal(await app.handlePairingCallback(callback({ token: second, apiKey: OTHER_KEY })), true);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, OTHER_KEY);

    await app.unpair('tenant-1');
    assert.equal(await app.handlePairingCallback(callback({ token: second })), false);
    const direct = new SmsTunnelService({ storage: new TenantStorage(db, 'tenant-1'), callbackBaseUrl: '' });
    assert.equal(await direct.handlePairingCallback(callback({ token: second })), false);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, null);
  });

  it("the SDK alone clears the activation key the app used to clear itself", async () => {
    net.restore();
    net = stubFetch({ 'POST /api/v1/saas/activate': activateAnswer(TOKEN) });
    const db = new Map([['tenant-1', { tenantId: 'tenant-1', smsSettings: { serverUrl: SERVER, apiKey: KEY } }]]);
    const sdk = new SmsTunnelService({
      storage: new TenantStorage(db, 'tenant-1'),
      callbackBaseUrl: 'https://api.tenants.test/v1',
      enterpriseApiKey: ENTERPRISE_KEY,
      externalId: 'tenant-1',
    });
    assert.equal((await sdk.createPairingToken()).success, true);
    assert.equal(db.get('tenant-1').smsSettings.apiKey, '');
    assert.equal(db.get('tenant-1').smsSettings.siteToken, TOKEN);
  });
});
