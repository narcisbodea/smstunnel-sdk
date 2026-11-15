// SmsTunnelNodeClient: the idempotencyKey option, SmsTunnelApiError.retryAfter and scheduled texts, against a local
// stand-in that answers like smstunnel.io's send routes (SMSserver public-api/idempotency: same key + same request
// within 24 h replays the first answer, the same key with a different request gets 422) and its /sms/scheduled routes
// (SMSserver scheduled-texts: only the texts of the key that scheduled them).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SmsTunnelNodeClient, SmsTunnelApiError } from '../dist/node/index.mjs';

const apiKey = 'sk_' + 'live_' + '0123456789abcdef0123456789abcdef';
const requests = [];
const remembered = new Map(); // idempotency key -> { fingerprint, status, body }
const scheduled = new Map(); // scheduled text id -> the text, as GET /api/v1/sms/scheduled/:id answers it
let textsSent = 0;
let server;
let base;

const answer = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const refusal = (res, status, code, message, extra = {}) =>
  answer(res, status, { statusCode: status, error: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : status === 403 ? 'Forbidden' : 'Bad Request', code, message, ...extra });

/** GET /api/v1/sms/scheduled[?scope=], GET and DELETE /api/v1/sms/scheduled/:id */
function scheduledRoutes(req, res) {
  const url = new URL(req.url, 'http://stand-in');
  const id = decodeURIComponent(url.pathname.split('/')[5] ?? '');
  if (!id && req.method === 'GET') {
    const done = url.searchParams.get('scope') === 'done';
    const items = [...scheduled.values()].filter((item) => (item.status === 'scheduled') !== done);
    const waiting = [...scheduled.values()].filter((item) => item.status === 'scheduled').length;
    const page = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return answer(res, 200, { success: true, data: { items, total: items.length, page, limit, waiting, max: 10 } });
  }
  const item = scheduled.get(id);
  if (!item) return refusal(res, 404, 'SCHEDULE_NOT_FOUND', 'This scheduled text no longer exists.');
  if (req.method === 'GET') return answer(res, 200, { success: true, data: item });
  if (req.method === 'DELETE') {
    if (item.status !== 'scheduled') {
      return refusal(res, 409, 'SCHEDULE_NOT_EDITABLE', 'This text has already gone out or was canceled, or was scheduled through the API (cancel it instead).');
    }
    item.status = 'canceled';
    return answer(res, 200, { success: true, data: item });
  }
  return answer(res, 404, { statusCode: 404, message: `Cannot ${req.method} ${url.pathname}` });
}

function handle(req, res, raw) {
  const body = raw ? JSON.parse(raw) : undefined;
  const key = req.headers['idempotency-key'];
  requests.push({ method: req.method, path: req.url, key, body });
  const to = Array.isArray(body?.to) ? body.to[0] : body?.to;

  if (req.url.startsWith('/api/v1/sms/scheduled')) return scheduledRoutes(req, res);
  // The server before scheduled texts: its validation refuses a property it doesn't know.
  if (to === '+15550001400') return answer(res, 400, { statusCode: 400, error: 'Bad Request', message: ['property sendAt should not exist'] });
  if (to === '+15550001401') return refusal(res, 400, 'SCHEDULE_TOO_SOON', 'Pick a time at least a minute from now. To send it now, use Send.');
  if (to === '+15550001403') {
    return refusal(res, 403, 'SCHEDULE_LIMIT_REACHED', 'You have as many scheduled texts as your plan allows. Wait until some go out, or cancel one.', { max: 10 });
  }
  if (to === '+15550000429') return answer(res, 429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, { 'Retry-After': '17' });
  if (to === '+15550000430') return answer(res, 429, { statusCode: 429, message: "You reached today's limit of 300 texts." });
  if (to === '+15550000666') return answer(res, 429, { statusCode: 429, message: 'Too Many Requests' }, { 'Retry-After': 'soon' });
  if (to === '+15550000503') {
    const at = new Date(Date.now() + 120_000).toUTCString();
    return answer(res, 503, { statusCode: 503, message: 'Service Unavailable' }, { 'Retry-After': at });
  }
  if (to === '+15550000409') {
    return answer(
      res,
      409,
      { statusCode: 409, code: 'IDEMPOTENCY_KEY_IN_PROGRESS', message: 'A request with this Idempotency-Key is still being processed.' },
      { 'Retry-After': '1' },
    );
  }

  const fingerprint = `${req.url}\n${raw}`;
  if (key !== undefined) {
    const earlier = remembered.get(key);
    if (earlier && earlier.fingerprint !== fingerprint) {
      return answer(res, 422, { statusCode: 422, code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different request.' });
    }
    if (earlier) return answer(res, earlier.status, earlier.body, { 'Idempotent-Replayed': 'true' });
  }

  if (body?.sendAt !== undefined) {
    const id = (scheduled.size + 1).toString(16).padStart(24, '0');
    const item = {
      id,
      to: body.to,
      message: body.message,
      sendAt: new Date(body.sendAt).toISOString(),
      status: 'scheduled',
      deviceId: body.deviceId ?? null,
      messageId: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    scheduled.set(id, item);
    const result = { success: true, scheduled: true, scheduledId: id, sendAt: item.sendAt, data: item };
    if (key !== undefined) remembered.set(key, { fingerprint, status: 200, body: result });
    return answer(res, 200, result);
  }

  textsSent += 1;
  const id = `msg_${textsSent}`;
  // A list of numbers: one id per number, as SMSTunnel answers it.
  const result = Array.isArray(body?.to)
    ? { success: true, data: { messageIds: body.to.map((_, i) => `${id}_${i}`), branded: false, count: body.to.length, remaining: { clean: 9, total: 9 } } }
    : { success: true, messageId: id, data: { messageId: id, branded: false, remaining: { clean: 9, total: 9 } } };
  if (key !== undefined) remembered.set(key, { fingerprint, status: 200, body: result });
  // The text has gone out; this answer comes too late for a client with a short timeout.
  if (to === '+15550000999') return setTimeout(() => answer(res, 200, result), 400);
  return answer(res, 200, result);
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handle(req, res, raw));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const client = (timeout) => new SmsTunnelNodeClient({ apiKey, serverUrl: base, ...(timeout ? { timeout } : {}) });
const last = () => requests[requests.length - 1];

describe('idempotencyKey', () => {
  it('goes out as the Idempotency-Key header, never in the body', async () => {
    const sms = client();
    await sms.sendSms('+14155550123', 'Your order #1042 has shipped.', undefined, { idempotencyKey: 'order-1042-shipped' });
    assert.equal(last().key, 'order-1042-shipped');
    assert.deepEqual(last().body, { to: '+14155550123', message: 'Your order #1042 has shipped.' });

    await sms.sendSms('+14155550123', 'See you at 10:30.', undefined, { defaultCountryCode: '+40' });
    assert.equal(last().key, undefined);
    assert.deepEqual(last().body, { to: '+14155550123', message: 'See you at 10:30.', defaultCountryCode: '+40' });
  });

  it('is taken by every send call that has options', async () => {
    const sms = client();
    await sms.send2FaSms('+14155550123', 'Your sign-in code is 482913', { idempotencyKey: 'code-1', deviceId: 'd1' });
    assert.equal(last().path, '/api/v1/sms/send-2fa');
    assert.equal(last().key, 'code-1');
    assert.equal(last().body.deviceId, 'd1');

    await sms.sendEncryptedSms('ZW5jcnlwdGVk', 'd1', { to: '+14155550123', idempotencyKey: 'sealed-1' });
    assert.equal(last().path, '/api/v1/sms/send');
    assert.equal(last().key, 'sealed-1');
    assert.equal(last().body.encryptedPayload, 'ZW5jcnlwdGVk');

    await sms.sendBulkSms(['+14155550123'], 'Your table is ready.', undefined, { idempotencyKey: 'table-7' });
    assert.equal(last().key, 'table-7');
    assert.ok(!('idempotencyKey' in last().body));
  });

  it('makes a retry safe: the answer that never arrived comes back, and the text goes out once', async () => {
    const before = textsSent;
    const options = { idempotencyKey: 'reminder-2026-11-07-ana' };
    await assert.rejects(client(150).sendSms('+15550000999', 'Reminder: tomorrow at 10:30.', undefined, options), {
      name: 'AbortError',
    });
    const retried = await client().sendSms('+15550000999', 'Reminder: tomorrow at 10:30.', undefined, options);
    assert.equal(textsSent, before + 1);
    assert.equal(retried.messageId, `msg_${before + 1}`);

    // The same key for a different text is refused, and nothing goes out.
    await assert.rejects(client().sendSms('+14155550199', 'Another text', undefined, options), (error) => {
      assert.ok(error instanceof SmsTunnelApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
      return true;
    });
    assert.equal(textsSent, before + 1);
  });

  it('that SMSTunnel would refuse, or would read as no key, throws before anything is sent', async () => {
    const sms = client();
    const count = requests.length;
    for (const idempotencyKey of ['', ' ', ' x', 'x ', 'é', 'a\nb', 'x'.repeat(256), 42, {}, null]) {
      await assert.rejects(
        sms.sendSms('+14155550123', 'x', undefined, { idempotencyKey }),
        TypeError,
        JSON.stringify(idempotencyKey),
      );
    }
    await assert.rejects(sms.sendEncryptedSms('cGF5bG9hZA==', 'd1', { expectedFingerprint: 'ab', idempotencyKey: ' ' }), TypeError);
    assert.equal(requests.length, count);

    await sms.sendSms('+14155550123', 'x', undefined, { idempotencyKey: 'k'.repeat(255) });
    assert.equal(last().key, 'k'.repeat(255));
    await sms.sendSms('+14155550123', 'y', undefined, { idempotencyKey: 'a b' });
    assert.equal(last().key, 'a b');
  });
});

describe('SmsTunnelApiError.retryAfter', () => {
  const failure = async (to) => {
    try {
      await client().sendSms(to, 'x');
    } catch (error) {
      assert.ok(error instanceof SmsTunnelApiError);
      return error;
    }
    assert.fail('no error');
  };

  it('is the seconds of Retry-After', async () => {
    const tooMany = await failure('+15550000429');
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.retryAfter, 17);

    const inProgress = await failure('+15550000409');
    assert.equal(inProgress.status, 409);
    assert.equal(inProgress.code, 'IDEMPOTENCY_KEY_IN_PROGRESS');
    assert.equal(inProgress.retryAfter, 1);
  });

  it('turns an HTTP date into the seconds left', async () => {
    const unavailable = await failure('+15550000503');
    assert.equal(unavailable.status, 503);
    assert.ok(unavailable.retryAfter >= 110 && unavailable.retryAfter <= 121, String(unavailable.retryAfter));
  });

  it('is undefined without a usable Retry-After', async () => {
    const limit = await failure('+15550000430');
    assert.equal(limit.status, 429);
    assert.equal(limit.retryAfter, undefined);
    assert.equal((await failure('+15550000666')).retryAfter, undefined);
  });

  it('keeps the two-argument constructor', () => {
    const error = new SmsTunnelApiError(429, { message: 'Too Many Requests', code: 'X' });
    assert.equal(error.message, 'Too Many Requests');
    assert.equal(error.code, 'X');
    assert.equal(error.retryAfter, undefined);
    assert.equal(new SmsTunnelApiError(429, {}, 5).retryAfter, 5);
    assert.equal(new SmsTunnelApiError(429, {}, -1).retryAfter, undefined);
    assert.equal(new SmsTunnelApiError(429, {}, Number.NaN).retryAfter, undefined);
  });
});

describe('scheduled texts', () => {
  const sends = () => requests.filter((request) => request.method === 'POST');

  it('sendAt goes out as toISOString(), from a Date or a string with its offset', async () => {
    const sms = client();
    const at = new Date(Date.now() + 3_600_000);
    const fromDate = await sms.sendSms('+14155550123', 'Reminder: tomorrow at 10:30.', undefined, { sendAt: at });
    assert.equal(last().path, '/api/v1/sms/send');
    assert.deepEqual(last().body, { to: '+14155550123', message: 'Reminder: tomorrow at 10:30.', sendAt: at.toISOString() });

    for (const [given, sent] of [
      ['2026-11-16T09:00:00+02:00', '2026-11-16T07:00:00.000Z'],
      ['2026-11-16T09:00Z', '2026-11-16T09:00:00.000Z'],
      [' 2026-11-16 09:00:00.123456-0500 ', '2026-11-16T14:00:00.123Z'],
      ['2026-11-16t09:00:00z', '2026-11-16T09:00:00.000Z'],
      ['2026-11-16T09:00:00+05', '2026-11-16T04:00:00.000Z'],
      ['2028-02-29T23:30:00-01:00', '2028-03-01T00:30:00.000Z'],
    ]) {
      await sms.sendSms('+14155550123', 'Hi', undefined, { sendAt: given });
      assert.equal(last().body.sendAt, sent, given);
    }

    // The scheduled answer, apart from a text sent now.
    assert.equal(fromDate.success, true);
    assert.equal(fromDate.scheduled, true);
    assert.match(fromDate.scheduledId, /^[0-9a-f]{24}$/);
    assert.equal(fromDate.sendAt, at.toISOString());
    assert.deepEqual(
      { ...fromDate.data, createdAt: undefined },
      {
        id: fromDate.scheduledId,
        to: '+14155550123',
        message: 'Reminder: tomorrow at 10:30.',
        sendAt: at.toISOString(),
        status: 'scheduled',
        deviceId: null,
        messageId: null,
        error: null,
        createdAt: undefined,
      },
    );
    assert.equal(fromDate.messageId, undefined);
  });

  it('goes with the phone, the country code and the idempotencyKey; without sendAt nothing changes', async () => {
    const sms = client();
    await sms.sendSms('0721123456', 'See you at 10:30.', 'd1', {
      defaultCountryCode: '+40',
      idempotencyKey: 'reminder-ana-1',
      sendAt: '2026-11-16T09:00:00+02:00',
    });
    assert.equal(last().key, 'reminder-ana-1');
    assert.deepEqual(last().body, {
      to: '0721123456',
      message: 'See you at 10:30.',
      deviceId: 'd1',
      defaultCountryCode: '+40',
      sendAt: '2026-11-16T07:00:00.000Z',
    });

    const now = await sms.sendSms('+14155550123', 'Sent now', undefined, { sendAt: undefined });
    assert.ok(!('sendAt' in last().body));
    assert.match(now.messageId, /^msg_\d+$/);
    assert.equal(now.scheduled, undefined);
  });

  it('a retry with the same idempotencyKey gets the same scheduled text back', async () => {
    const options = { idempotencyKey: 'reminder-2026-11-16-ion', sendAt: '2026-11-16T09:00:00+02:00' };
    const count = scheduled.size;
    const first = await client().sendSms('+14155550124', 'Reminder', undefined, options);
    const again = await client().sendSms('+14155550124', 'Reminder', undefined, options);
    assert.equal(again.scheduledId, first.scheduledId);
    assert.equal(scheduled.size, count + 1);
    // The same key at another time is another request: refused, and nothing more is scheduled.
    await assert.rejects(
      client().sendSms('+14155550124', 'Reminder', undefined, { ...options, sendAt: '2026-11-16T10:00:00+02:00' }),
      { name: 'SmsTunnelApiError', code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    assert.equal(scheduled.size, count + 1);
  });

  it('a string without its offset, an invalid or impossible date throws a TypeError before anything is sent', async () => {
    const sms = client();
    const count = requests.length;
    for (const sendAt of [
      '2026-11-16T09:00:00',
      '2026-11-16T09:00',
      '2026-11-16',
      'tomorrow at 9',
      '',
      '2026-02-30T09:00:00Z',
      '2026-11-16T24:00:00Z',
      '2026-11-16T09:60:00Z',
      '2026-11-16T09:00:00+24:00',
      '16/11/2026 09:00 +02:00',
      new Date('not a date'),
      1794812400000,
      null,
      {},
    ]) {
      await assert.rejects(sms.sendSms('+14155550123', 'x', undefined, { sendAt }), TypeError, String(sendAt));
    }
    await assert.rejects(sms.sendSms('+14155550123', 'x', undefined, { sendAt: '2026-11-16T09:00:00' }), /has no offset: add Z for UTC/);
    await assert.rejects(sms.sendSms('+14155550123', 'x', undefined, { sendAt: '2026-02-30T09:00:00Z' }), /not a real date and time/);
    await assert.rejects(sms.sendSms('+14155550123', 'x', undefined, { sendAt: new Date('x') }), /invalid Date/);
    assert.equal(requests.length, count);
  });

  it('lists, gets and cancels the texts this key scheduled', async () => {
    const sms = client();
    const { scheduledId } = await sms.sendSms('+14155550125', 'Your table is ready at 20:00.', undefined, {
      sendAt: '2026-11-16T18:00:00Z',
    });

    const waiting = await sms.listScheduled();
    assert.equal(last().method, 'GET');
    assert.equal(last().path, '/api/v1/sms/scheduled');
    assert.ok(waiting.data.items.some((item) => item.id === scheduledId));
    assert.equal(waiting.data.max, 10);
    assert.equal(typeof waiting.data.waiting, 'number');

    await sms.listScheduled({ scope: 'done', page: 2, limit: 20 });
    assert.equal(last().path, '/api/v1/sms/scheduled?scope=done&page=2&limit=20');

    const one = await sms.getScheduled(scheduledId);
    assert.equal(last().path, `/api/v1/sms/scheduled/${scheduledId}`);
    assert.equal(one.data.status, 'scheduled');

    const canceled = await sms.cancelScheduled(scheduledId);
    assert.equal(last().method, 'DELETE');
    assert.equal(last().path, `/api/v1/sms/scheduled/${scheduledId}`);
    assert.equal(last().body, undefined);
    assert.equal(canceled.data.status, 'canceled');
    assert.ok((await sms.listScheduled({ scope: 'done' })).data.items.some((item) => item.id === scheduledId));

    // Canceled already: 409, with the code.
    await assert.rejects(sms.cancelScheduled(scheduledId), (error) => {
      assert.ok(error instanceof SmsTunnelApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'SCHEDULE_NOT_EDITABLE');
      return true;
    });
    await assert.rejects(sms.getScheduled('ffffffffffffffffffffffff'), { status: 404, code: 'SCHEDULE_NOT_FOUND' });
  });

  it('refuses an id or a scope that cannot be one, before anything is asked', async () => {
    const sms = client();
    const count = requests.length;
    for (const id of ['', '  ', undefined, null, 42]) {
      await assert.rejects(sms.getScheduled(id), TypeError, String(id));
      await assert.rejects(sms.cancelScheduled(id), TypeError, String(id));
    }
    await assert.rejects(sms.listScheduled({ scope: 'all' }), TypeError);
    assert.equal(requests.length, count);

    await assert.rejects(sms.getScheduled('a/b?c'), { status: 404 });
    assert.equal(last().path, '/api/v1/sms/scheduled/a%2Fb%3Fc');
  });

  it('a refusal keeps its status and code; the older server\'s 400 is thrown like any 400', async () => {
    const sms = client();
    const at = { sendAt: '2026-11-16T09:00:00+02:00' };
    const before = sends().length;

    await assert.rejects(sms.sendSms('+15550001401', 'x', undefined, at), (error) => {
      assert.ok(error instanceof SmsTunnelApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'SCHEDULE_TOO_SOON');
      assert.match(error.message, /at least a minute from now/);
      return true;
    });
    await assert.rejects(sms.sendSms('+15550001403', 'x', undefined, at), (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'SCHEDULE_LIMIT_REACHED');
      assert.equal(error.body.max, 10);
      return true;
    });
    await assert.rejects(sms.sendSms('+15550001400', 'x', undefined, at), (error) => {
      assert.ok(error instanceof SmsTunnelApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, undefined);
      assert.equal(error.message, 'property sendAt should not exist');
      return true;
    });
    assert.equal(sends().length, before + 3);
  });
});
