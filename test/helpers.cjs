// Shared by the tests. They run against dist/ (npm test builds it first): what the package ships.
const { Logger } = require('@nestjs/common');

/** A fake API key, built from pieces so no real-looking key sits in the source. */
const fakeKey = (tail) => 'sk_' + 'live_' + tail;

/** 64 hex characters, like SMSTunnel's pairing tokens. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY = fakeKey('0123456789abcdef0123456789abcdef');
const OTHER_KEY = fakeKey('ffffffffffffffffffffffffffffffff');
const SERVER = 'https://smstunnel.test';

/** A storage adapter in memory, like the README's JSON-file one: it keeps every field it is given. */
function memoryStorage(initial = {}) {
  const state = { serverUrl: SERVER, ...initial };
  const writes = [];
  return {
    state,
    writes,
    async getConfig() {
      return { ...state };
    },
    async updateConfig(partial) {
      writes.push({ ...partial });
      Object.assign(state, partial);
    },
    async clearConfig() {
      writes.push('clear');
      for (const name of Object.keys(state)) if (name !== 'serverUrl') state[name] = '';
    },
  };
}

/** Everything NestJS's Logger is asked to write, while `capture()` is on. */
function captureLogs() {
  const lines = [];
  const levels = ['log', 'warn', 'error', 'debug', 'verbose'];
  const saved = Object.fromEntries(levels.map((level) => [level, Logger.prototype[level]]));
  for (const level of levels) {
    Logger.prototype[level] = function (message) {
      lines.push(`${level}: ${String(message)}`);
    };
  }
  return {
    lines,
    text: () => lines.join('\n'),
    restore() {
      for (const level of levels) Logger.prototype[level] = saved[level];
    },
  };
}

/**
 * Replaces global fetch: `routes` maps "METHOD path" to a handler `(init, url) => ({ status, body, headers })`.
 * Anything else throws, so no test can reach a real server. `calls` lists what was asked.
 */
function stubFetch(routes = {}) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: url.toString(), path: url.pathname, headers: { ...(init.headers || {}) }, body: init.body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new TypeError(`fetch failed (no network in tests: ${method} ${url.pathname})`);
    const answer = await handler(init, url);
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(answer.headers || {}) },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = saved;
    },
  };
}

/** Lets the work a call started in the background (the key exchange after a pairing) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A v2 QR code: base64 of `{ s, t, n, v }`. */
const qrDataFor = (token) =>
  Buffer.from(JSON.stringify({ s: SERVER, t: token, n: 'Acme Dental', v: 2 })).toString('base64');

module.exports = { fakeKey, TOKEN, KEY, OTHER_KEY, SERVER, memoryStorage, captureLogs, stubFetch, settle, qrDataFor };
