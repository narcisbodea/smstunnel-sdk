// Scheduled texts through SmsTunnelService (NestJS): sendSms() with sendAt, listScheduled(), getScheduled() and
// cancelScheduled(), against stubbed answers shaped like smstunnel.io's (SMSserver public-api, scheduled-texts).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { SmsTunnelService } = require('../dist/server/index.js');
const { KEY, SERVER, memoryStorage, captureLogs, stubFetch } = require('./helpers.cjs');

const ID = '6735a0c4e1d9e1b7b54cf994';
const item = (fields = {}) => ({
  id: ID,
  to: '+40712345678',
  message: 'Reminder: your appointment is tomorrow at 10:00.',
  sendAt: '2026-11-16T07:00:00.000Z',
  status: 'scheduled',
  deviceId: null,
  messageId: null,
  error: null,
  createdAt: '2026-11-15T12:00:00.000Z',
  ...fields,
});
const scheduledAnswer = () => ({
  status: 200,
  body: { success: true, scheduled: true, scheduledId: ID, sendAt: '2026-11-16T07:00:00.000Z', data: item() },
});
const refusal = (status, code, message, extra = {}) => ({
  status,
  body: { statusCode: status, error: status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Request', code, message, ...extra },
});

const service = (storage = memoryStorage({ apiKey: KEY })) =>
  new SmsTunnelService({ storage, callbackBaseUrl: 'https://app.test/api', displayName: 'Test App' });

let logs;
let net;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  net?.restore();
  net = undefined;
  logs.restore();
});

describe('SmsTunnelService.sendSms() with sendAt', () => {
  it('sends sendAt as toISOString() and answers the scheduled text', async () => {
    net = stubFetch({ 'POST /api/v1/sms/send': scheduledAnswer });
    const sdk = service();

    const result = await sdk.sendSms('+40712345678', 'Reminder: your appointment is tomorrow at 10:00.', {
      sendAt: '2026-11-16T09:00:00+02:00',
    });
    assert.deepEqual(JSON.parse(net.calls[0].body), {
      to: '+40712345678',
      message: 'Reminder: your appointment is tomorrow at 10:00.',
      sendAt: '2026-11-16T07:00:00.000Z',
    });
    assert.equal(net.calls[0].headers['X-API-Key'], KEY);
    assert.deepEqual(result, {
      success: true,
      scheduled: true,
      scheduledId: ID,
      sendAt: '2026-11-16T07:00:00.000Z',
      data: item(),
    });
    assert.match(logs.text(), new RegExp(`SMS scheduled via SMSTunnel: ${ID} for 2026-11-16T07:00:00.000Z`));

    const at = new Date('2026-11-16T07:00:00.000Z');
    await sdk.sendSms('+40712345678', 'Reminder', { sendAt: at });
    assert.equal(JSON.parse(net.calls[1].body).sendAt, '2026-11-16T07:00:00.000Z');
  });

  it('without sendAt, sends and answers as before', async () => {
    net = stubFetch({
      'POST /api/v1/sms/send': () => ({
        status: 200,
        body: { success: true, messageId: 'm1', data: { messageId: 'm1', branded: false, remaining: { clean: 9, total: 9 } } },
      }),
    });
    const sdk = service();

    const result = await sdk.sendSms('+40712345678', 'Your order has shipped.');
    await sdk.sendSms('+40712345678', 'Your order has shipped.', { sendAt: undefined });
    for (const call of net.calls) {
      assert.deepEqual(JSON.parse(call.body), { to: '+40712345678', message: 'Your order has shipped.' });
    }
    assert.deepEqual(result, {
      success: true,
      messageId: 'm1',
      data: { messageId: 'm1', branded: false, remaining: { clean: 9, total: 9 } },
    });
  });

  it('a sendAt without its offset, or an invalid date, fails without asking SMSTunnel', async () => {
    net = stubFetch({ 'POST /api/v1/sms/send': scheduledAnswer });
    const sdk = service();

    for (const sendAt of ['2026-11-16T09:00:00', '2026-02-30T09:00:00Z', 'tomorrow', new Date('nope'), 1794812400000]) {
      const result = await sdk.sendSms('+40712345678', 'x', { sendAt });
      assert.equal(result.success, false, String(sendAt));
      assert.match(result.error, /^sendAt /, String(sendAt));
      assert.equal(result.status, undefined);
    }
    assert.match((await sdk.sendSms('+40712345678', 'x', { sendAt: '2026-11-16T09:00:00' })).error, /has no offset/);
    assert.equal(net.calls.length, 0);
  });

  it('a refusal comes back with its status, code and, for the plan cap, max', async () => {
    const answers = {
      '+15550001401': refusal(400, 'SCHEDULE_TOO_SOON', 'Pick a time at least a minute from now. To send it now, use Send.'),
      '+15550001403': refusal(403, 'SCHEDULE_LIMIT_REACHED', 'You have as many scheduled texts as your plan allows.', { max: 10 }),
      '+15550001404': refusal(404, 'SCHEDULE_PHONE_NOT_FOUND', "This phone isn't in your account anymore."),
      // The server before scheduled texts.
      '+15550001400': { status: 400, body: { statusCode: 400, error: 'Bad Request', message: ['property sendAt should not exist'] } },
    };
    net = stubFetch({ 'POST /api/v1/sms/send': (init) => answers[JSON.parse(init.body).to] });
    const sdk = service();
    const at = { sendAt: '2026-11-16T09:00:00+02:00' };

    const soon = await sdk.sendSms('+15550001401', 'x', at);
    assert.deepEqual(
      [soon.success, soon.status, soon.code, soon.error],
      [false, 400, 'SCHEDULE_TOO_SOON', 'Pick a time at least a minute from now. To send it now, use Send.'],
    );
    const full = await sdk.sendSms('+15550001403', 'x', at);
    assert.deepEqual([full.success, full.status, full.code, full.max], [false, 403, 'SCHEDULE_LIMIT_REACHED', 10]);
    const phone = await sdk.sendSms('+15550001404', 'x', at);
    assert.deepEqual([phone.status, phone.code], [404, 'SCHEDULE_PHONE_NOT_FOUND']);
    const old = await sdk.sendSms('+15550001400', 'x', at);
    assert.deepEqual([old.success, old.status, old.code, old.error], [false, 400, undefined, 'property sendAt should not exist']);
  });
});

describe('SmsTunnelService scheduled texts', () => {
  it('lists, gets and cancels them with the stored key', async () => {
    net = stubFetch({
      'GET /api/v1/sms/scheduled': (init, url) => ({
        status: 200,
        body: {
          success: true,
          data: { items: [item()], total: 1, page: Number(url.searchParams.get('page') ?? 1), limit: 50, waiting: 3, max: 10 },
        },
      }),
      [`GET /api/v1/sms/scheduled/${ID}`]: () => ({ status: 200, body: { success: true, data: item() } }),
      [`DELETE /api/v1/sms/scheduled/${ID}`]: () => ({ status: 200, body: { success: true, data: item({ status: 'canceled' }) } }),
    });
    const sdk = service();

    const waiting = await sdk.listScheduled();
    assert.equal(net.calls[0].url, `${SERVER}/api/v1/sms/scheduled`);
    assert.deepEqual(waiting, { success: true, data: { items: [item()], total: 1, page: 1, limit: 50, waiting: 3, max: 10 } });
    await sdk.listScheduled({ scope: 'done', page: 2, limit: 20 });
    assert.equal(net.calls[1].url, `${SERVER}/api/v1/sms/scheduled?scope=done&page=2&limit=20`);

    assert.deepEqual(await sdk.getScheduled(ID), { success: true, data: item() });
    assert.equal(net.calls[2].method, 'GET');

    assert.deepEqual(await sdk.cancelScheduled(ID), { success: true, data: item({ status: 'canceled' }) });
    assert.equal(net.calls[3].method, 'DELETE');
    assert.equal(net.calls[3].path, `/api/v1/sms/scheduled/${ID}`);
    assert.equal(net.calls[3].body, undefined);
    for (const call of net.calls) assert.equal(call.headers['X-API-Key'], KEY);
  });

  it('a refusal comes back with its status and code', async () => {
    net = stubFetch({
      [`DELETE /api/v1/sms/scheduled/${ID}`]: () =>
        refusal(409, 'SCHEDULE_NOT_EDITABLE', 'This text has already gone out or was canceled, or was scheduled through the API (cancel it instead).'),
      'GET /api/v1/sms/scheduled/ffffffffffffffffffffffff': () => refusal(404, 'SCHEDULE_NOT_FOUND', 'This scheduled text no longer exists.'),
      'GET /api/v1/sms/scheduled': () => ({
        status: 403,
        body: { statusCode: 403, error: 'Forbidden', code: 'PERMISSION_REQUIRED', permission: 'sms:read', message: 'This API key lacks sms:read.' },
      }),
    });
    const sdk = service();

    const late = await sdk.cancelScheduled(ID);
    assert.deepEqual([late.success, late.status, late.code], [false, 409, 'SCHEDULE_NOT_EDITABLE']);
    assert.match(late.error, /already gone out or was canceled/);
    const gone = await sdk.getScheduled('ffffffffffffffffffffffff');
    assert.deepEqual([gone.success, gone.status, gone.code], [false, 404, 'SCHEDULE_NOT_FOUND']);
    const denied = await sdk.listScheduled();
    assert.deepEqual([denied.status, denied.code, denied.permission], [403, 'PERMISSION_REQUIRED', 'sms:read']);
  });

  it('refuses an empty id or an unknown scope, and an app with no key, without asking SMSTunnel', async () => {
    net = stubFetch();
    const sdk = service();
    for (const id of ['', '  ', undefined, 42]) {
      assert.equal((await sdk.getScheduled(id)).success, false, String(id));
      assert.match((await sdk.cancelScheduled(id)).error, /scheduledId must be/, String(id));
    }
    assert.match((await sdk.listScheduled({ scope: 'all' })).error, /scope must be 'waiting' or 'done'/);

    const unpaired = service(memoryStorage());
    assert.deepEqual(await unpaired.cancelScheduled(ID), { success: false, error: 'SMSTunnel is not configured.' });
    assert.deepEqual(await unpaired.listScheduled(), { success: false, error: 'SMSTunnel is not configured.' });
    assert.equal(
      (await unpaired.sendSms('+40712345678', 'x', { sendAt: '2026-11-16T09:00:00Z' })).error,
      'SMSTunnel is not configured. Pair a device first.',
    );
    assert.equal(net.calls.length, 0);
  });
});
