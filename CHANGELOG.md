# Changelog

## [2.2.0] - 2026-11-06

### Security: the NestJS pairing callback could store someone else's API key

`POST /smstunnel/callback` is a public route: SMSTunnel's server posts the phone's new API key there when the phone
scans your QR code. Up to 2.1.1, the token check was skipped whenever no token was stored: before the first QR
pairing, after pairing with an API key, and after unpairing. In those states the route stored a key sent by anyone,
and from then on your app's texts, sign-in codes included, would have gone out through that person's account. The
older `POST /wp-json/smstunnel/v1/setup-callback` had the same flaw. Update if you use `SmsTunnelModule`, or if you call
`handlePairingCallback()` or `handleLegacyCallback()` yourself.

A callback is now stored only when all of these hold:

- a token is stored, and the posted token is that token, compared in constant time;
- no API key is stored yet. `createPairingToken()` now clears the stored key when it stores a new token (see Changed),
  so a real pairing always finds none, and a token can't be used again once its phone is paired;
- `token` and `apiKey` are strings of visible characters (16 to 512), and `deviceId` (up to 128) and `deviceName` (up
  to 256) are strings when present.

Anything else answers `{ success: false }` and stores nothing, and the log says why without the token or the key (it
used to show the first characters of both).

To check an app that ran an older version: send yourself a text from it and look for it on dashboard.smstunnel.io. A
text goes through the account of the key the app stores, so if it isn't there, or you are unsure, unpair and pair the
phone again.

### Changed

- **`createPairingToken()` starts a new pairing.** Once SMSTunnel has issued the token, it is stored and the stored API
  key is cleared (`apiKey: ''`), so `paired` is `false` until the phone scans the QR code. When the call fails, or
  SMSTunnel's answer has no token, nothing is stored. The React and Vue pairing components offer a QR code only when
  no phone is paired, so they behave as before.
- **Enterprise mode: the activation's key is no longer stored.** `createPairingToken()` used to keep the `apiKey` of
  the `/api/v1/saas/activate` answer. Now the key arrives with the phone's `pairing_completed` callback, as in the
  public flow. If your app makes a new QR code for a client whose phone is already linked, it stops sending for that
  client until the phone scans the new code. The Node client's `activateEnterpriseClient()` still returns the
  activation's key.
- **`enableLegacyCallback` is honoured, and off by default.** `POST /wp-json/smstunnel/v1/setup-callback` is mounted
  by `forRoot()` only with `enableLegacyCallback: true`; with `forRootAsync()`, whose options are known only at
  runtime, the route stays mapped and answers 404 unless the options enable it. Before 2.2.0 it was always mounted,
  although the option existed. QR pairing doesn't use this route. It now lives in `SmsTunnelLegacyController`.
- The pairing-status proxy (`GET /smstunnel/pairing-status/:token`) puts the token into SMSTunnel's URL encoded.

### Fixed

- **`SmsTunnelModule.forRoot()` and `forRootAsync()` work again, on NestJS 10, 11 and 12** (checked with 10.4.22,
  11.2.8 and 12.3.3, in CommonJS and ESM apps). 2.1.1 was built without decorator metadata, so NestJS 11 and 12
  stopped at startup (`Nest can't resolve dependencies of the SmsTunnelAuthGuard (?, SMSTUNNEL_OPTIONS)`), and on
  NestJS 10 every route the module mounts answered 500. Every class the module provides now names its dependencies
  with `@Inject()`, so nothing depends on metadata, neither in this build nor in your tsconfig. `SmsTunnelService`
  used on its own, without the module, worked before and is unchanged.
- **TypeScript with `"moduleResolution": "node"`** (older NestJS projects) finds `/node`, `/server`, `/react`, `/vue`
  and `/angular` (TS2307 before), through `typesVersions`. `node16`, `nodenext` and `bundler` are unchanged.

### New: safe retries in the Node client (`/node`)

- **`idempotencyKey`** in the options of `sendSms()`, `send2FaSms()` and `sendEncryptedSms()` (and of every call that
  takes the same options). It goes out as the `Idempotency-Key` header. For 24 hours, a repeat of the same call with
  the same key gets the first answer back (the same `messageId`) instead of a second text; the same key with a
  different text, number, phone or country code is refused (422, `code: 'IDEMPOTENCY_KEY_REUSED'`). Use one new key
  per text and the same key on every retry of it. A key SMSTunnel can't take (empty, over 255 characters, not printable
  ASCII, spaces at the ends) throws a `TypeError` before anything is sent.
- **`SmsTunnelApiError.retryAfter`**: the seconds of the answer's `Retry-After`, on a 429 for too many requests and on
  a 409 for a key whose first try is still running (`code: 'IDEMPOTENCY_KEY_IN_PROGRESS'`). Undefined when SMSTunnel
  sends none, for example on a 429 for a daily limit.
- The client still never retries on its own. `encryptAndSendSms()` and `sendSealedSms()` encrypt anew on every call,
  so they take no key: encrypt once with `encrypt()` or `sealText()` and retry `sendEncryptedSms()` with the key.

### Package

- `npm test` builds the package and runs its tests: the callback rules, the module on NestJS, the Node client and
  TypeScript resolution. `prepublishOnly` runs it.
- The build no longer asks for decorator metadata, so it is the same with or without `@swc/core` installed.

## [2.1.1] - 2026-11-02

From a report by an app built on the NestJS module.

- **NestJS `sendSms()`** now also returns SMSTunnel's details in `data`: `branded` (a short free-plan line was
  added) and today's `remaining` allowance, as `send2fa()` and the encrypted calls already did. `queued` is unchanged.
- **NestJS `getSmsStatus()`** is typed: `SmsStatusResult`, with `unconfirmed` and `deliveryStatus`
  (`SmsDeliveryStatus`), both exported.
- **NestJS `apiGet()` / `apiPost()`** are public, for API calls this module doesn't wrap yet. They answer like the
  other calls: SMSTunnel's body, or `{ success: false, status, error, code? }`.
- README: "Build it with an AI assistant" prompt; country codes: `defaultCountryCode` always takes precedence
  (server rule since 2026-11-01).

## [2.1.0] - 2026-11-01

Checked call by call against smstunnel.io as of 2026-11-01 (end-to-end encryption on every plan, Maximum privacy on
Professional and Enterprise).

### Fixed: calls that never worked against the server

- **NestJS `sendBulk()` / `POST /smstunnel/send-bulk`** sent `{ messages }`, which SMSTunnel refuses (400). It now groups
  the texts by wording and sends `{ to: [...], message }`, up to 100 numbers per request, and returns one result per
  text: `{ success, results: [{ to, messageId?, error? }] }`. The route also takes `{ to: [...], message }`.
- **NestJS `send2fa()` / `POST /smstunnel/send-2fa`** sent `{ to, code, template }`, which SMSTunnel refuses (400). It
  now sends the text: `template` with `{code}` replaced, the template followed by the code, or
  `Your verification code: <code>`. The route also takes `{ to, message }`.
- **NestJS `exchangeKeys()`** asked for `GET /api/v1/devices/:id`, which an API key can't reach (404), and read the
  phone list from the wrong place, so it never stored a key and `encryptAndSendSms()` always failed. It now uses
  `/public-key` and `/e2e-status`. `encryptAndSendSms()` exchanges keys first when none are stored.
- **NestJS `pairWithApiKey()`** read the phone list from the wrong place: it stored no `deviceId` and named every phone
  "Android Phone". `sendSealedSms()` finds the phone the same way when none is stored.
- **Browser routes `GET /smstunnel/e2e-status/:deviceId`, `GET /smstunnel/public-key/:deviceId` and
  `POST /smstunnel/verify-key`** were called by `SmsTunnelClient`, React, Vue and Angular and listed in this README, but
  the controller had lost them in 1.1.8 (404). They are back, with `getDeviceE2EStatus()`, `getDevicePublicKey()` and
  `verifyDeviceKey()` on `SmsTunnelService`.
- **`POST /smstunnel/send-encrypted` dropped `to`**, and since 2026-10-31 SMSTunnel refuses an encrypted text without it
  below Professional (403). The route passes it on, and `sendEncryptedSms()` in `SmsTunnelClient`, React, Vue and
  Angular takes it as a 4th argument: `sendEncryptedSms(payload, deviceId, is2FA, to)`.
- **Angular** `provideSmsTunnel({ getAuthHeaders })`, shown in this README, was ignored. It works now.

### Changed

- **NestJS failures have one shape:** SMSTunnel's body plus `success: false`, the HTTP `status` and `error` in words,
  e.g. `{ success: false, status: 403, code: 'PERMISSION_REQUIRED', permission: 'sms:inbox', error: 'This API key may
  not read received texts…' }`. Before, the raw body came back with no `success`, and `error` was often only
  `Forbidden`. If you compared `error` with `'Forbidden'`, compare `status` instead. `createPairingToken()` keeps
  `error: 'SMSTunnel returned error: <status>'` and adds `status` and `code` (e.g. `CONCURRENT_ACTIVATION`).
- **Node errors:** the client throws `SmsTunnelApiError`, still an `Error` with the server's message, now with `status`,
  `code`, `permission` and `body`. A list of validation messages is joined with `; ` (it was joined with `,`).
- **Types now match what the server sends** (compile-time only: code that compiled against the old shapes was
  reading fields that never arrived):
  - `SmsTunnelClient` (`@narcisbodea/smstunnel-sdk`): `DevicesResponse.data` is `{ devices, online, total }` (was an
    array), `ReceivedSmsResponse.data` is `{ messages, total, page, limit, hasMore }` (was an array),
    `AccountUsageResponse.data` is `{ plan, usage, limits, remaining }`, `SmsStatusResponse.data` is `{ id,
    phoneNumber, status, deliveryStatus, ... }`, `SendSmsResponse.data.remaining` is `{ clean, total }`.
  - Angular `DevicesResult.data` is `{ devices, online, total }`.
  - Node: received texts have `sender` and `message` (and `isEncrypted`, `deviceName`, ...), phones have `lastSeenAt`,
    message status has `deliveryStatus` and `unconfirmed`, E2E pairing status has `e2eVersion`, usage is typed. The
    old names `from`, `body` and `lastSeen` keep working: the SDK fills them in, marked deprecated.
  - `SaasActivateResult.activation.pairingCode` is optional: SMSTunnel doesn't send one in the Enterprise flow.
- **Deprecated, because SMSTunnel answers 401 to an API key** (they need a dashboard sign-in): Node `createPairingToken()`,
  `listPairings()`, `unpair()`; `getPairings()` everywhere. They still make the same call.

### New

- Node `createPublicPairingToken({ displayName, callbackUrl })`: a QR code and a code to type that link a phone to your
  software, without sending your API key.
- Node Enterprise calls (Enterprise app key): `activateEnterpriseClient()`, `getEnterpriseClient(externalId)`,
  `getEnterpriseActivation(activationId)`. NestJS: `getEnterpriseClientStatus()`.
- Node `sendSms()`, `send2FaSms()` and `sendBulkSms()` take `{ defaultCountryCode }`; `send2FaSms()` also `{ deviceId }`.
- `getReceivedSms()` takes `limit`, `page`, `since`, `phone`, `deviceId` in the NestJS service and route, `SmsTunnelClient`
  and Angular.

### Also in 2.1.0

- **Fixed:** encrypting failed with the key phones actually report (bare base64 SPKI, `ERR_OSSL_UNSUPPORTED`).
  `encrypt()` and `encryptAndSendSms()` now take PEM or bare base64.
- **Fixed:** the Enterprise flow kept the older `activation.token` as `siteToken` and in `pollUrl`, so the phone's
  `pairing_completed` callback was refused and polling answered 404. It now keeps the token inside the QR code.
- **Changed:** `encryptAndSendSms()` sends `to` too, so your Messages page shows who a text went to. Only the phone can
  read the words. `sendEncryptedSms()` takes `to` as an option.
- **Changed:** format v2 is padded, so the packet's size doesn't give away how long a text is.
- **New:** Maximum privacy (Professional and Enterprise plans, app 1.0.9 or newer): `openCertificate()`, `sealText()` and
  `sendSealedSms()`. The number is sealed too, and the key and the password stay on your machine.
- **New:** `smstunnel-make-certificate`, to make a certificate on your own machine.

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
