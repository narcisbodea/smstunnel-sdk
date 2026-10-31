# Changelog

## [2.0.1] - 2026-10-28

Documentation and package metadata only. No code changes; `dist/` is identical to 2.0.0.

- README wording: sending to several recipients (max 100 per request, rate-limited),
  received SMS (synced from your phone, only if you enabled sync; needs an API key
  explicitly allowed to read received messages, QR-pairing keys cannot), Enterprise mode.
- package.json: new description and keywords.
- Server note (smstunnel.io v1.0.8, no SDK change): in Enterprise/SaaS mode, calling `createPairingToken()` (`POST /api/v1/saas/activate`) again for the same `externalId` answers **201** — also when a phone is already linked — and replaces the earlier activation: its records are deleted, and the sub-account's activation API keys created at least 60 seconds earlier — plus its oldest active key, of any source — are retired, while the linked phone stays connected to the same sub-account. The SDK stores the new `siteToken` and API key from that response at once, so integrators need no change. When two calls for the same `externalId` overlap, both usually get 201 and both returned keys stay active until the next call at least 60 seconds later, so the key from whichever response the SDK stores last works (calls that do not overlap behave like sequential calls: the later one retires the earlier one's key at once — keep the response that arrives last); the server may also answer one of the calls **409** (`code: 'CONCURRENT_ACTIVATION'`, or `'ALREADY_CONNECTED'` when a phone completed setup on the winning activation meanwhile), which the SDK returns as `{ success: false, error: 'SMSTunnel returned error: 409' }` (the body with the code is in its warning log) — use the other call's result or call it again. A whitespace-only `displayName` now gets 400, and the occasional 500 when the server created the new API key (a collision of its masked display value) is gone.

---

## [2.0.0] - 2026-07-06

Major release. Consolidates the unpublished 1.2.3 and 1.2.4 changes (see below).
Bumped to a major version because of one **BREAKING** change.

### BREAKING
- **NestJS `/server` routes are now secure-by-default.** A built-in guard blocks
  every route except the three public ones. If you relied on unauthenticated
  routes you MUST add an `authenticate(req)` predicate or `authGuard` in
  `SmsTunnelModule.forRoot()` — or pass `authenticate: () => true` to defer to an
  existing global guard. Without an auth strategy, non-public routes fail closed.
  See the 1.2.3 migration notes below.

### Also included
- SSRF / API-key exfiltration protection on `update-config` (1.2.3).
- Source maps no longer shipped in the package (1.2.3).
- Opt-in E2E v2 hybrid encryptor, default OFF — no effect unless enabled (1.2.4).

---

## [1.2.4] - 2026-06-12

### Added — E2E v2 hybrid encryptor (opt-in, v1 stays default)

The SDK can now build the `encryptedPayload` transport string itself, in two
interop formats shared with the WordPress plugin and the Flutter app
(`docs/e2e-v2-hybrid-spec.md`):

- **v1 (legacy, DEFAULT):** RSA PKCS#1 v1.5 over the UTF-8 payload —
  `base64( RSA_encrypt(payload) )`. Unchanged behaviour.
- **v2 (hybrid, opt-in):** AES-256-GCM payload + RSA-OAEP(SHA-1) AES-key wrap,
  envelope `{ v:2, k, iv, ct, t }` → `base64(utf8(JSON.stringify(envelope)))`.
  Removes the ~245-byte v1 limit for long messages.

New crypto helpers (Node-only), exported from both `/server` and `/node`:
`encryptPayload()` (gated dispatcher), `encryptPayloadV1()`, `encryptPayloadV2()`,
and `decryptPayload()` (v1+v2 backward-compatible, for round-trip/parity).

**Gating — v2 is used ONLY when BOTH hold, else v1:**
1. feature flag ON — `SmsTunnelModule.forRoot({ e2eHybrid: true })` /
   `new SmsTunnelNodeClient({ e2eHybrid: true })` (default `false`), AND
2. the device advertises `e2eVersion >= 2` (captured during `exchangeKeys()` and
   stored as `SmsTunnelConfig.deviceE2eVersion`; unknown ⇒ v1).

So with the flag off (default), every message stays v1 → zero risk to existing
phones.

New convenience methods:
- Server: `SmsTunnelService.encrypt(payload)` and
  `encryptAndSendSms(to, message, is2FA?)`.
- Node: `SmsTunnelNodeClient.encrypt(payload, publicKeyPem, deviceE2eVersion?)`
  and `encryptAndSendSms(to, message, deviceId, options?)`.

New options/fields: `SmsTunnelModuleOptions.e2eHybrid`,
`SmsTunnelNodeClientOptions.e2eHybrid`, `SmsTunnelConfig.deviceE2eVersion`.

RSA-OAEP uses SHA-1 (Node's `crypto.publicEncrypt` default for
`RSA_PKCS1_OAEP_PADDING`), matching PHP `OPENSSL_PKCS1_OAEP_PADDING` and Dart
`OAEPEncoding`. No breaking changes.

## [1.2.3] - 2026-06-12

### Security

**Secure-by-default NestJS routes (BREAKING for unauthenticated setups).**
- The `/server` module now ships a built-in guard (`SmsTunnelAuthGuard`)
  applied to the controller. Every route is protected except the three
  public ones (`callback`, `pairing-status/:token`, legacy WP callback),
  which are marked with the new `@SmsTunnelPublic()` decorator and detected
  via reflector metadata (no URL string matching).
- New `SmsTunnelModuleOptions.authenticate(req)` predicate and
  `authGuard` option to supply your auth strategy in `forRoot()`.
- **Fail-closed:** if no auth strategy is configured, non-public routes are
  blocked and a warning is logged at startup. Previously all routes were
  open unless the consumer wired up their own guard.
- New exports: `SmsTunnelAuthGuard`, `SmsTunnelPublic`,
  `SMSTUNNEL_IS_PUBLIC_KEY`, type `CanActivateLike`.

**SSRF / API-key exfiltration protection on `update-config`.**
- `updateServerUrl()` / `POST /smstunnel/update-config` now validate the
  supplied `serverUrl`. Runtime override is disabled by default
  (`allowServerUrlOverride: false`); when enabled, only `https://` URLs on
  the host allowlist (`serverUrlAllowlist`, default `['smstunnel.io']` and
  subdomains) are accepted. Private/loopback/link-local/metadata hosts are
  always rejected. Invalid values are not persisted; the route returns 400.

**Build no longer publishes source maps.**
- `tsup` `sourcemap` set to `false` for all entry points so original source
  is not shipped in the npm package.

### Migration

- If you relied on routes being unauthenticated, add an `authenticate`
  predicate (or `authGuard`) in `SmsTunnelModule.forRoot()`.
- If you already protect these routes with a global guard via
  `SMSTUNNEL_PUBLIC_PATHS`, pass `authenticate: () => true` to defer to it.
- If your app sets the SMSTunnel server URL from a request, set
  `allowServerUrlOverride: true` (and adjust `serverUrlAllowlist` if you use
  a custom/self-hosted host).

## [1.2.2] - 2026-04-05

### Changed
- Client: added `updateServerUrl()` method
- React: added `qrSize` prop to SmsTunnelPairing, new label `pairingCodeLabel` and `pairingCodeCopied`
- Vue: added E2E methods to useSmsTunnel composable
- Server: added `displayUrl` to SmsTunnelModuleOptions, `getPairings()` service method
- Labels: added `pairingCodeLabel` and `pairingCodeCopied` to EN/RO labels
- Dependencies: updated Angular to v21, NestJS to v11

## [1.1.2] - 2026-03-10

### Added — E2E Encryption + Angular + Node.js Standalone

**E2E Encryption support across all entry points:**

- New methods on all SDKs: `getDeviceE2EStatus()`, `getDevicePublicKey()`, `verifyDeviceKey()`, `sendEncryptedSms()`
- Automatic key fingerprint verification before sending encrypted SMS
- Device key change detection (detects reinstalls, triggers re-pairing)
- New types: `DeviceE2EStatus`, `DevicePublicKeyInfo`, `VerifyDeviceKeyResult`

**New entry point: `@narcisbodea/smstunnel-sdk/angular`**

- Angular 17+ injectable service (`SmsTunnelService`) with `InjectionToken`-based config
- `provideSmsTunnel()` factory for standalone Angular apps
- Full feature parity: pairing, SMS, devices, E2E encryption, config
- All response types exported

**New entry point: `@narcisbodea/smstunnel-sdk/node`**

- Standalone Node.js client (`SmsTunnelNodeClient`) — no NestJS or framework dependency
- Uses native `fetch` (Node 18+), zero external dependencies
- API key authentication (`X-API-Key` header)
- Full SMS, devices, E2E encryption, unified pairing v2, and E2E pairing support
- `pollE2EPairing()` convenience method with configurable interval/timeout
- Request timeout with `AbortController`

**Server module updates:**

- New controller endpoints: `GET e2e-status/:deviceId`, `GET public-key/:deviceId`, `POST verify-key`, `POST send-encrypted`, `GET pairings`
- Corresponding service methods added to `SmsTunnelService`

**React & Vue updates:**

- `useSmsTunnel()` hook/composable now returns E2E methods
- `sendEncryptedSms()`, `getDeviceE2EStatus()`, `getDevicePublicKey()`, `verifyDeviceKey()`

## [1.1.0] - 2026-03-09

### Added — Multi-Tenant (Enterprise/SaaS) Support

SMSTunnel SDK now supports **multi-tenant architectures**. Applications that operate as SaaS platforms (e.g., CRM, ERP, booking systems) can provision SMS capabilities for each of their tenants automatically.

**What changed:**

- `createPairingToken()` now supports two modes:
  - **Single-tenant** (default, unchanged): Uses `POST /api/v1/pairing/public-create` — creates independent SMSTunnel accounts.
  - **Multi-tenant / Enterprise**: Uses `POST /api/v1/saas/activate` — creates sub-accounts under your Enterprise account. Each tenant gets their own isolated SMS device pairing.

- New options on `SmsTunnelModuleOptions`:
  - `enterpriseApiKey` — Your Enterprise App API Key from SMSTunnel. When set, activates multi-tenant mode.
  - `externalId` — Unique identifier for the tenant in your system (e.g., company ID, client slug).

- New exported type `SaasActivateResult` — fully typed response from `/api/v1/saas/activate`.

**Usage:**

```typescript
SmsTunnelModule.forRootAsync({
  useFactory: (settingsModel) => ({
    storage: new MongoSmsTunnelStorage(settingsModel),
    callbackBaseUrl: process.env.CALLBACK_URL,
    displayName: 'My SaaS App',
    // Multi-tenant mode
    enterpriseApiKey: process.env.SMSTUNNEL_ENTERPRISE_API_KEY,
    externalId: tenant.id, // your tenant/client identifier
  }),
  inject: [getModelToken('Settings')],
})
```

**Flow:**
1. Your app calls `createPairingToken()` for a tenant
2. SDK calls SMSTunnel → creates a sub-account for that tenant
3. Tenant scans QR with Android phone → device pairs under your Enterprise umbrella
4. SMSTunnel sends callback with API key → SDK saves it via storage adapter
5. Your app can now send SMS on behalf of that tenant

No breaking changes — existing single-tenant setups continue to work without modification.

## [1.0.1] - 2026-03-03

### Fixed
- Initial stable release with unified pairing v2 support.

## [1.0.0] - 2026-03-01

### Added
- NestJS module (`SmsTunnelModule`) with storage adapter pattern.
- React components (`SmsTunnelPairing`, `QrCodeCanvas`, `useSmsTunnel` hook).
- Vue 3 components (`SmsTunnelPairing`, `QrCodeCanvas`, `useSmsTunnel` composable).
- Framework-agnostic `SmsTunnelClient` class.
- Built-in i18n labels (EN, RO).
