// SmsTunnelNodeClient: the idempotencyKey option and SmsTunnelApiError.retryAfter, against a local stand-in that
// answers like smstunnel.io's send routes (SMSserver public-api/idempotency: same key + same request within 24 h
// replays the first answer, the same key with a different request gets 422).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SmsTunnelNodeClient, SmsTunnelApiError } from '../dist/node/index.mjs';

const apiKey = 'sk_' + 'live_' + '0123456789abcdef0123456789abcdef';
const requests = [];
const remembered = new Map(); // idempotency key -> { fingerprint, status, body }
let textsSent = 0;
let server;
let base;

const answer = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function handle(req, res, raw) {
  const body = raw ? JSON.parse(raw) : undefined;
  const key = req.headers['idempotency-key'];
  requests.push({ method: req.method, path: req.url, key, body });
  const to = Array.isArray(body?.to) ? body.to[0] : body?.to;

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
