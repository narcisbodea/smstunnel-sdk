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
