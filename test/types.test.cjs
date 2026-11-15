// TypeScript finds every entry point with moduleResolution "node" (node10), node16, nodenext and bundler. Before
// 2.2.0, "node" ignored the package's `exports` and reported TS2307 for /node and /server; `typesVersions` fixes it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const pkgName = '@narcisbodea/smstunnel-sdk';

const consumer = `
import { SmsTunnelNodeClient, SmsTunnelApiError, type SendOptions } from '${pkgName}/node';
import { SmsTunnelModule, SmsTunnelService, type PairingCallbackBody } from '${pkgName}/server';
import { SmsTunnelClient } from '${pkgName}';
import type * as ReactEntry from '${pkgName}/react';
import type * as VueEntry from '${pkgName}/vue';
import type * as AngularEntry from '${pkgName}/angular';

const options: SendOptions = { idempotencyKey: 'order-1042-shipped', defaultCountryCode: '+40' };
export function secondsToWait(error: unknown): number | undefined {
  return error instanceof SmsTunnelApiError ? error.retryAfter : undefined;
}
export const used = [SmsTunnelNodeClient, SmsTunnelModule, SmsTunnelService, SmsTunnelClient, options];
export type Used = [PairingCallbackBody, typeof ReactEntry, typeof VueEntry, typeof AngularEntry];
`;

// Scheduled texts: sendSms() answers ScheduleSmsResponse with a sendAt, SendSmsResponse without one (as before 2.3.0),
// and either when sendAt may be undefined. Each @ts-expect-error must meet its error (TS2578 otherwise).
const scheduledConsumer = `
import {
  SmsTunnelNodeClient,
  type ListScheduledResponse,
  type ScheduleSmsResponse,
  type ScheduledText,
  type ScheduledTextStatus,
  type SendOptions,
  type SendSmsResponse,
} from '${pkgName}/node';
import { SmsTunnelService, type ScheduleSmsResult, type ScheduledTextResult, type SendSmsResult } from '${pkgName}/server';

declare const client: SmsTunnelNodeClient;
declare const service: SmsTunnelService;
declare const maybe: Date | undefined;
declare const options: SendOptions;

export async function check() {
  const now: SendSmsResponse = await client.sendSms('+14155550123', 'Now');
  const nowToo: SendSmsResponse = await client.sendSms('+14155550123', 'Now', 'phone-1', options);
  const later: ScheduleSmsResponse = await client.sendSms('+14155550123', 'Later', undefined, {
    sendAt: new Date(),
    idempotencyKey: 'k',
  });
  const atText: ScheduleSmsResponse = await client.sendSms('+14155550123', 'Later', 'phone-1', { sendAt: '2026-11-16T09:00:00+02:00' });
  const text: ScheduledText = later.data;
  const either = await client.sendSms('+14155550123', 'Maybe', undefined, { sendAt: maybe });
  const id: string | undefined = either.scheduled ? either.scheduledId : either.messageId;
  // @ts-expect-error a scheduled send has no messageId yet
  later.messageId;
  // @ts-expect-error a text sent now has no scheduledId
  now.scheduledId;
  // @ts-expect-error only sendSms() takes sendAt
  await client.send2FaSms('+14155550123', 'Code 482913', { sendAt: new Date() });
  // @ts-expect-error sendAt is a Date or a string
  await client.sendSms('+14155550123', 'Later', undefined, { sendAt: 1794812400000 });

  const page: ListScheduledResponse = await client.listScheduled({ scope: 'done', page: 1, limit: 20 });
  // @ts-expect-error scope is 'waiting' or 'done'
  await client.listScheduled({ scope: 'all' });
  const status: ScheduledTextStatus = (await client.cancelScheduled(later.scheduledId)).data.status;
  const sent: string | null = (await client.getScheduled(later.scheduledId)).data.messageId;

  const nestNow: SendSmsResult = await service.sendSms('+14155550123', 'Now');
  const nestLater: ScheduleSmsResult = await service.sendSms('+14155550123', 'Later', { sendAt: '2026-11-16T09:00:00+02:00' });
  const nestEither = await service.sendSms('+14155550123', 'Maybe', { sendAt: maybe });
  const nestId: string | undefined = nestEither.scheduled ? nestEither.scheduledId : nestEither.messageId;
  const canceled: ScheduledTextResult = await service.cancelScheduled(nestLater.scheduledId ?? '');
  return [now, nowToo, later, atText, text, id, page, status, sent, nestNow, nestLater, nestId, canceled];
}
`;

// An app on SDK 2.0.1 with module commonjs declares the subpath itself (an ambient module); it must keep compiling.
const shim = `declare module '${pkgName}/server' {
  export * from '${pkgName}/dist/server/index';
}
`;
const shimConsumer = `/// <reference path="./shim.d.ts" />
import { SmsTunnelService, type SmsTunnelStorageAdapter } from '${pkgName}/server';
const storage: SmsTunnelStorageAdapter = { getConfig: async () => ({}), updateConfig: async () => {}, clearConfig: async () => {} };
export const sdk = new SmsTunnelService({ storage, callbackBaseUrl: '' });
`;

const modes = {
  node10: { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 },
  node16: { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
  nodenext: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
  bundler: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
};

function diagnostics(files, mode) {
  const program = ts.createProgram(files, {
    ...modes[mode],
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    types: ['node'],
    typeRoots: [path.join(root, 'node_modules', '@types')],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

let dir;
// Everything made here, removed one by one in reverse order. Never a recursive delete: two of these are links to
// this repository, and a recursive delete that followed one would empty it.
const made = [];
const mkdir = (p) => (fs.mkdirSync(p), made.push({ kind: 'dir', p }), p);
const link = (target, p) => (fs.symlinkSync(target, p, 'junction'), made.push({ kind: 'link', p }), p);
const write = (p, text) => (fs.writeFileSync(p, text), made.push({ kind: 'file', p }), p);

/** A project whose node_modules/@narcisbodea/smstunnel-sdk is `target` (a link), with the files given. */
function project(name, target, files) {
  const base = mkdir(path.join(dir, name));
  const scope = mkdir(path.join(mkdir(path.join(base, 'node_modules')), '@narcisbodea'));
  if (target) link(target, path.join(scope, 'smstunnel-sdk'));
  for (const [file, text] of Object.entries(files)) write(path.join(base, file), text);
  return (file) => path.join(base, file);
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smstunnel-sdk-types-'));
});
after(() => {
  for (const { kind, p } of made.reverse()) {
    if (kind === 'link') {
      try {
        fs.unlinkSync(p);
      } catch {
        fs.rmdirSync(p); // a junction on some Windows versions; removes the link only
      }
    } else if (kind === 'file') fs.unlinkSync(p);
    else fs.rmdirSync(p);
  }
  fs.rmdirSync(dir);
});

describe('TypeScript finds the entry points', () => {
  it('with moduleResolution node, node16, nodenext and bundler', () => {
    const file = project('consumer', root, { 'index.ts': consumer, 'package.json': '{ "private": true }' });
    for (const mode of Object.keys(modes)) {
      assert.deepEqual(diagnostics([file('index.ts')], mode), [], mode);
    }
  });

  it('and without typesVersions, "node" would not (the 2.1.1 behaviour)', () => {
    const file = project('control', null, { 'index.ts': consumer, 'package.json': '{ "private": true }' });
    const pkgDir = mkdir(path.join(dir, 'control', 'node_modules', '@narcisbodea', 'smstunnel-sdk'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    delete manifest.typesVersions;
    write(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
    link(path.join(root, 'dist'), path.join(pkgDir, 'dist'));

    const errors = diagnostics([file('index.ts')], 'node10');
    assert.ok(errors.some((e) => e.startsWith('TS2307') && e.includes(`${pkgName}/node`)), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('TS2307') && e.includes(`${pkgName}/server`)), errors.join('\n'));
    assert.deepEqual(diagnostics([file('index.ts')], 'nodenext'), []);
  });

  it('and a project that declared the subpath itself (an ambient-module shim) still compiles', () => {
    const file = project('shim', root, { 'shim.d.ts': shim, 'app.ts': shimConsumer });
    assert.deepEqual(diagnostics([file('app.ts')], 'node10'), []);
  });
});

describe('TypeScript types of scheduled texts', () => {
  it('sendSms() answers the scheduled text only with a sendAt, and a text sent now without one', () => {
    const file = project('scheduled', root, { 'index.ts': scheduledConsumer, 'package.json': '{ "private": true }' });
    for (const mode of ['node10', 'bundler']) {
      assert.deepEqual(diagnostics([file('index.ts')], mode), [], mode);
    }
  });
});
