# Changelog

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
