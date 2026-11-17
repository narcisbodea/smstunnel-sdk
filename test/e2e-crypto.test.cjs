// End-to-end encryption in any alphabet (2.4.0): the hybrid format (v2) is the default for a phone that reads it, v1
// stays for every other phone, and a text too long for v1 fails before anything is sent. Every v2 packet is opened
// again with decryptPayload(), the mirror of the phone's decryptor (SMSApp crypto_manager.dart); every v1 packet is
// opened with the raw RSA operation, because Node 20+ refuses PKCS#1 v1.5 decryption.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const node = require('../dist/node/index.js');
const server = require('../dist/server/index.js');
const { KEY, SERVER, memoryStorage, captureLogs, stubFetch } = require('./helpers.cjs');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// The API and the phones give the key as bare base64 SPKI.
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const TO = '+40712345678';
const DEVICE = '6735a0c4e1d9e1b7b54cf001';

/** `phrase` repeated, cut to exactly `length` characters (code points, so an emoji is never split). */
const textOf = (phrase, length) => [...phrase.repeat(Math.ceil(length / [...phrase].length))].slice(0, length).join('');

// 1600 characters: the public API's cap.
const LONG = {
  cyrillic: textOf('Здравствуйте! Ваш заказ отправлен и прибудет завтра. ', 1600),
  arabic: textOf('مرحبا، تم شحن طلبك وسيصل غدا. ', 1600),
  chinese: textOf('您好，您的订单已发货，明天送达。', 1600),
  emoji: textOf('📦🚚✅🎉👍🏽 ', 1600),
  romanian: textOf('Bună ziua! Comanda dumneavoastră a fost expediată și ajunge mâine. Mulțumim! ', 1600),
  greek: textOf('Γεια σας! Η παραγγελία σας στάλθηκε και φτάνει αύριο. ', 1600),
};

const payloadOf = (message) => JSON.stringify({ to: TO, message });

/** The v2 envelope inside a transport string, or null for anything else (a v1 packet). */
function envelopeOf(transport) {
  try {
    const envelope = JSON.parse(Buffer.from(transport, 'base64').toString('utf8'));
    return envelope && envelope.v === 2 ? envelope : null;
  } catch {
    return null;
  }
}

/** Opens a v2 packet like the phone does and answers `{ to, message }`. */
function openV2(transport) {
  assert.ok(envelopeOf(transport), 'a v2 envelope');
  const opened = JSON.parse(node.decryptPayload(transport, PRIVATE_PEM));
  assert.equal(typeof opened.pad, 'string', 'v2 packets are padded');
  return { to: opened.to, message: opened.message };
}

/** Opens a v1 packet (RSA PKCS#1 v1.5 type 2 block) with the raw RSA operation and answers its text. */
function openV1(transport) {
  const block = Buffer.from(transport, 'base64');
  assert.equal(block.length, 256, 'one RSA-2048 block');
  assert.equal(envelopeOf(transport), null, 'not a v2 envelope');
  const raw = crypto.privateDecrypt({ key: PRIVATE_PEM, padding: crypto.constants.RSA_NO_PADDING }, block);
  assert.equal(raw[0], 0);
  assert.equal(raw[1], 2);
  const end = raw.indexOf(0, 2);
  assert.ok(end >= 10, 'at least 8 bytes of padding');
  return raw.subarray(end + 1).toString('utf8');
}

describe('encryptPayload()', () => {
  for (const [alphabet, message] of Object.entries(LONG)) {
    it(`sends 1600 characters of ${alphabet} in the hybrid format to a phone that reads it, without e2eHybrid`, () => {
      const transport = node.encryptPayload(payloadOf(message), PUBLIC_B64, { deviceE2eVersion: 2 });
      assert.deepEqual(openV2(transport), { to: TO, message });
    });
  }

  it('the /server copy is the same encryptor', () => {
    const transport = server.encryptPayload(payloadOf(LONG.chinese), PUBLIC_B64, { deviceE2eVersion: 3 });
    assert.deepEqual(openV2(transport), { to: TO, message: LONG.chinese });
  });

  it('uses v1 for a phone that reads only v1, or whose format is not known', () => {
    const payload = payloadOf('Your order has shipped.');
    for (const options of [undefined, {}, { deviceE2eVersion: 1 }, { deviceE2eVersion: undefined }, { e2eHybrid: true }]) {
      assert.equal(openV1(node.encryptPayload(payload, PUBLIC_B64, options)), payload);
    }
  });

  it('e2eHybrid: false keeps v1 even for a phone that reads the hybrid format', () => {
    const payload = payloadOf('Your order has shipped.');
    assert.equal(openV1(node.encryptPayload(payload, PUBLIC_B64, { e2eHybrid: false, deviceE2eVersion: 2 })), payload);
    assert.throws(
      () => node.encryptPayload(payloadOf(LONG.cyrillic), PUBLIC_B64, { e2eHybrid: false, deviceE2eVersion: 2 }),
      node.E2eV1TooLongError,
    );
  });

  it('v1 carries non-Latin text as UTF-8, up to 245 bytes', () => {
    // {"to":"+40712345678","message":""} is 34 bytes; a Cyrillic letter takes 2.
    const fits = payloadOf('Ж'.repeat(105) + 'z');
    assert.equal(Buffer.byteLength(fits), 245);
    assert.equal(openV1(node.encryptPayload(fits, PUBLIC_B64, { deviceE2eVersion: 1 })), fits);

    const tooLong = payloadOf('Ж'.repeat(106));
    assert.equal(Buffer.byteLength(tooLong), 246);
    assert.throws(() => node.encryptPayload(tooLong, PUBLIC_B64, { deviceE2eVersion: 1 }), (err) => {
      assert.ok(err instanceof node.E2eV1TooLongError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'E2eV1TooLongError');
      assert.equal(err.code, 'E2E_V1_TOO_LONG');
      assert.equal(err.bytes, 246);
      assert.equal(err.maxBytes, 245);
      assert.match(err.message, /too long for the phone's old encryption/);
      assert.match(err.message, /1\.0\.8/);
      assert.match(err.message, /e2eVersion/);
      return true;
    });
  });

  it('encryptPayloadV1() says the text is too long instead of throwing the OpenSSL error', () => {
    assert.throws(() => node.encryptPayloadV1(payloadOf(LONG.emoji), PUBLIC_B64), {
      name: 'E2eV1TooLongError',
      code: 'E2E_V1_TOO_LONG',
      maxBytes: 245,
    });
    assert.throws(() => server.encryptPayloadV1(payloadOf(LONG.emoji), PUBLIC_B64), server.E2eV1TooLongError);
  });

  it('the key size decides how much v1 carries (RSA-4096: 501 bytes)', () => {
    const big = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 }).publicKey.export({ type: 'spki', format: 'pem' });
    const fits = payloadOf('x'.repeat(501 - 34));
    assert.equal(Buffer.byteLength(fits), 501);
    assert.equal(Buffer.from(node.encryptPayloadV1(fits, big), 'base64').length, 512);
    assert.throws(() => node.encryptPayloadV1(payloadOf('x'.repeat(502 - 34)), big), { maxBytes: 501, bytes: 502 });
  });
});

let net;
let logs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  net?.restore();
  net = undefined;
  logs.restore();
});

const sent = () => ({ status: 200, body: { success: true, data: { messageId: 'msg-1', branded: false, remaining: { clean: 10, total: 10 } } } });
const keyAnswer = (fields = {}) => () => ({
  status: 200,
  body: { success: true, data: { deviceId: DEVICE, deviceName: 'Pixel', publicKey: PUBLIC_B64, ...fields } },
});
const statusAnswer = (fields = {}) => () => ({
  status: 200,
  body: { success: true, data: { encryptionEnabled: true, hasPublicKey: true, publicKeyFingerprint: 'abcdef0123456789', ...fields } },
});
const sends = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/sms/send');

describe('SmsTunnelNodeClient', () => {
  const client = (options = {}) => new node.SmsTunnelNodeClient({ apiKey: KEY, serverUrl: SERVER, ...options });

  it('encrypt() uses the hybrid format by default for a phone that reads it', () => {
    assert.deepEqual(openV2(client().encrypt({ to: TO, message: LONG.arabic }, PUBLIC_B64, 2)), { to: TO, message: LONG.arabic });
  });

  it('encrypt() with e2eHybrid: false stays on v1', () => {
    const payload = { to: TO, message: 'Hi' };
    assert.equal(openV1(client({ e2eHybrid: false }).encrypt(payload, PUBLIC_B64, 2)), JSON.stringify(payload));
    assert.throws(() => client({ e2eHybrid: false }).encrypt({ to: TO, message: LONG.greek }, PUBLIC_B64, 2), {
      code: 'E2E_V1_TOO_LONG',
    });
  });

  it('encryptAndSendSms() takes the phone\'s format from the key answer, when SMSTunnel gives it', async () => {
    net = stubFetch({ [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer({ e2eVersion: 2 }), 'POST /api/v1/sms/send': sent });
    const result = await client().encryptAndSendSms(TO, LONG.emoji, DEVICE);
    assert.equal(result.success, true);
    const body = JSON.parse(sends()[0].body);
    assert.equal(body.to, TO);
    assert.equal(body.encrypted, true);
    assert.equal(body.deviceId, DEVICE);
    assert.deepEqual(openV2(body.encryptedPayload), { to: TO, message: LONG.emoji });
  });

  it('encryptAndSendSms() takes the format the caller gives', async () => {
    net = stubFetch({ [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer(), 'POST /api/v1/sms/send': sent });
    const result = await client().encryptAndSendSms(TO, LONG.romanian, DEVICE, { deviceE2eVersion: 2 });
    assert.equal(result.success, true);
    assert.deepEqual(openV2(JSON.parse(sends()[0].body).encryptedPayload), { to: TO, message: LONG.romanian });
  });

  it('encryptAndSendSms() answers an error and sends nothing when the text is too long for v1', async () => {
    net = stubFetch({ [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer(), 'POST /api/v1/sms/send': sent });
    const result = await client().encryptAndSendSms(TO, LONG.chinese, DEVICE);
    assert.equal(result.success, false);
    assert.match(result.error, /too long for the phone's old encryption/);
    assert.equal(sends().length, 0);
  });

  it('encryptAndSendSms() still sends a short text to a phone whose format is not known, in v1', async () => {
    net = stubFetch({ [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer(), 'POST /api/v1/sms/send': sent });
    const result = await client().encryptAndSendSms(TO, 'Ваш код: 4829', DEVICE);
    assert.equal(result.success, true);
    assert.equal(openV1(JSON.parse(sends()[0].body).encryptedPayload), JSON.stringify({ to: TO, message: 'Ваш код: 4829' }));
  });
});

describe('SmsTunnelService (NestJS)', () => {
  const paired = (fields = {}) => memoryStorage({ apiKey: KEY, deviceId: DEVICE, devicePublicKey: PUBLIC_B64, deviceName: 'Pixel', ...fields });
  const service = (storage, options = {}) =>
    new server.SmsTunnelService({ storage, callbackBaseUrl: 'https://app.test/api', displayName: 'Test App', ...options });

  it('encryptAndSendSms() uses the hybrid format for a phone stored as reading it', async () => {
    net = stubFetch({ 'POST /api/v1/sms/send': sent });
    const result = await service(paired({ deviceE2eVersion: 2 })).encryptAndSendSms(TO, LONG.cyrillic);
    assert.equal(result.success, true);
    assert.equal(net.calls.length, 1);
    const body = JSON.parse(sends()[0].body);
    assert.equal(body.to, TO);
    assert.deepEqual(openV2(body.encryptedPayload), { to: TO, message: LONG.cyrillic });
  });

  it('encrypt() uses the hybrid format by default and v1 with e2eHybrid: false', async () => {
    const storage = paired({ deviceE2eVersion: 2 });
    assert.deepEqual(openV2(await service(storage).encrypt({ to: TO, message: LONG.greek })), { to: TO, message: LONG.greek });
    const payload = { to: TO, message: 'Hi' };
    assert.equal(openV1(await service(storage, { e2eHybrid: false }).encrypt(payload)), JSON.stringify(payload));
    await assert.rejects(service(storage, { e2eHybrid: false }).encrypt({ to: TO, message: LONG.greek }), server.E2eV1TooLongError);
  });

  it('a phone stored as v1-only: a long text asks SMSTunnel again and goes out in the hybrid format it now reports', async () => {
    const storage = paired({ deviceE2eVersion: 1 });
    net = stubFetch({
      [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer(),
      [`GET /api/v1/devices/${DEVICE}/e2e-status`]: statusAnswer({ e2eVersion: 2 }),
      'POST /api/v1/sms/send': sent,
    });
    const result = await service(storage).encryptAndSendSms(TO, LONG.arabic);
    assert.equal(result.success, true);
    assert.equal(storage.state.deviceE2eVersion, 2);
    assert.deepEqual(openV2(JSON.parse(sends()[0].body).encryptedPayload), { to: TO, message: LONG.arabic });
  });

  it('still v1-only after asking again: answers E2E_V1_TOO_LONG and sends nothing', async () => {
    const storage = paired({ deviceE2eVersion: 1 });
    net = stubFetch({
      [`GET /api/v1/devices/${DEVICE}/public-key`]: keyAnswer(),
      [`GET /api/v1/devices/${DEVICE}/e2e-status`]: statusAnswer(),
      'POST /api/v1/sms/send': sent,
    });
    const result = await service(storage).encryptAndSendSms(TO, LONG.chinese);
    assert.equal(result.success, false);
    assert.equal(result.code, 'E2E_V1_TOO_LONG');
    assert.match(result.error, /too long for the phone's old encryption/);
    assert.equal(sends().length, 0);
    assert.equal(storage.state.deviceE2eVersion, 1);
  });

  it('e2eHybrid: false: a long text answers the error without asking SMSTunnel again', async () => {
    net = stubFetch({});
    const result = await service(paired({ deviceE2eVersion: 2 }), { e2eHybrid: false }).encryptAndSendSms(TO, LONG.emoji);
    assert.equal(result.success, false);
    assert.equal(result.code, 'E2E_V1_TOO_LONG');
    assert.equal(net.calls.length, 0);
  });

  it('a short text to a v1-only phone still goes out in v1, without asking again', async () => {
    net = stubFetch({ 'POST /api/v1/sms/send': sent });
    const result = await service(paired({ deviceE2eVersion: 1 })).encryptAndSendSms(TO, 'Codul tău: 4829');
    assert.equal(result.success, true);
    assert.equal(net.calls.length, 1);
    assert.equal(openV1(JSON.parse(sends()[0].body).encryptedPayload), JSON.stringify({ to: TO, message: 'Codul tău: 4829' }));
  });
});
