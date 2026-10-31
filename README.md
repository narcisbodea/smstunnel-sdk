# @narcisbodea/smstunnel-sdk

SMSTunnel SDK - let your own software send texts through your own Android phone and number. Node.js + NestJS + React + Vue + Angular + framework-agnostic client for QR pairing, sending and E2E encryption.

The phone needs the [SMSTunnel app from Google Play](https://play.google.com/store/apps/details?id=io.smstunnel.app).

| Import path | Scope |
|---|---|
| `@narcisbodea/smstunnel-sdk` | `SmsTunnelClient` class + types + labels (Svelte, Astro, Solid, Vanilla JS) |
| `@narcisbodea/smstunnel-sdk/server` | NestJS module (backend proxy) |
| `@narcisbodea/smstunnel-sdk/react` | React components + hook (Next.js, Remix, Gatsby) |
| `@narcisbodea/smstunnel-sdk/vue` | Vue 3 components + composable (Nuxt) |
| `@narcisbodea/smstunnel-sdk/angular` | Angular 17+ injectable service |
| `@narcisbodea/smstunnel-sdk/node` | Standalone Node.js client (no framework, API key auth) |

## Install

```bash
npm install @narcisbodea/smstunnel-sdk
```

---

## Node.js (Standalone)

Works without NestJS or any framework. Uses native `fetch` (Node 18+), zero external dependencies.

```typescript
import { SmsTunnelNodeClient } from '@narcisbodea/smstunnel-sdk/node';

const client = new SmsTunnelNodeClient({
  apiKey: 'sk_live_xxx',
  serverUrl: 'https://smstunnel.io',
});

// Send SMS
const result = await client.sendSms('+40721123456', 'Hello!');

// Send 2FA
await client.send2FaSms('+40721123456', 'Your code is 123456');

// Send the same text to several of your recipients (max 100 per request, rate-limited)
await client.sendBulkSms(['+40721111111', '+40722222222'], 'Hello!');

// Get message status
const status = await client.getMessageStatus('msg-id');

// Get received SMS (synced from your phone, if you enabled sync).
// Sync is off by default; only texts that arrive after you turn it on are synced.
// Needs an API key you explicitly allowed to read received messages;
// keys issued through QR pairing cannot read them.
const received = await client.getReceivedSms({ limit: 20, page: 1 });

// List devices
const devices = await client.getDevices();

// E2E Encryption
const e2eStatus = await client.getDeviceE2EStatus('device-id');
const publicKey = await client.getDevicePublicKey('device-id');
const verification = await client.verifyDeviceKey('device-id', 'stored-fingerprint');
await client.sendEncryptedSms('encrypted-payload', 'device-id', {
  to: '+14155550123', // keeps the number visible in your Messages page; only the phone reads the words
  is2FA: false,
  expectedFingerprint: 'a1b2c3d4',
});

// Or in one call: fetches the phone's key, encrypts and sends.
await client.encryptAndSendSms('+14155550123', 'Your order has shipped.', 'device-id');

// Maximum privacy (Professional and Enterprise plans): the number is sealed too.
// Make the certificate in your dashboard, or with: npx -p @narcisbodea/smstunnel-sdk smstunnel-make-certificate
// import { openCertificate } from '@narcisbodea/smstunnel-sdk/node';
const certificate = openCertificate(readFileSync('smstunnel-certificate.json', 'utf8'), process.env.SMSTUNNEL_CERT_PASSWORD);
await client.sendSealedSms('+14155550123', 'Your order has shipped.', 'device-id', certificate);

// Unified Pairing v2
const pairing = await client.createPairingToken({
  source: 'api',
  displayName: 'My App',
});
const pairingStatus = await client.getPairingTokenStatus(pairing.data.token);

// E2E Pairing (with public key exchange)
const e2ePairing = await client.createE2EPairing({ siteName: 'My App' });
const e2eResult = await client.pollE2EPairing(e2ePairing.data.token);
// e2eResult.data.publicKey contains the device's RSA public key
```

---

## Server (NestJS)

### 1. Implement a Storage Adapter

The SDK is database-agnostic. You provide a simple adapter with 3 methods:

#### MongoDB (Mongoose)

```typescript
import { SmsTunnelStorageAdapter, SmsTunnelConfig } from '@narcisbodea/smstunnel-sdk/server';
import { Model } from 'mongoose';

export class MongoSmsTunnelStorage implements SmsTunnelStorageAdapter {
  constructor(private model: Model<any>) {}

  async getConfig(): Promise<Partial<SmsTunnelConfig>> {
    const doc = await this.model.findOne().lean().exec();
    return {
      serverUrl: doc?.smstunnelServerUrl || '',
      apiKey: doc?.smstunnelApiKey || '',
      siteToken: doc?.smstunnelSiteToken || '',
      deviceName: doc?.smstunnelDeviceName || '',
    };
  }

  async updateConfig(partial: Partial<SmsTunnelConfig>): Promise<void> {
    const $set: Record<string, string> = {};
    if (partial.serverUrl !== undefined) $set.smstunnelServerUrl = partial.serverUrl;
    if (partial.apiKey !== undefined) $set.smstunnelApiKey = partial.apiKey;
    if (partial.siteToken !== undefined) $set.smstunnelSiteToken = partial.siteToken;
    if (partial.deviceName !== undefined) $set.smstunnelDeviceName = partial.deviceName;
    await this.model.updateOne({}, { $set });
  }

  async clearConfig(): Promise<void> {
    await this.model.updateOne({}, {
      $set: { smstunnelApiKey: '', smstunnelDeviceName: '', smstunnelSiteToken: '' },
    });
  }
}
```

#### Prisma (PostgreSQL)

```typescript
import { SmsTunnelStorageAdapter, SmsTunnelConfig } from '@narcisbodea/smstunnel-sdk/server';
import { PrismaClient } from '@prisma/client';

export class PrismaSmsTunnelStorage implements SmsTunnelStorageAdapter {
  constructor(private prisma: PrismaClient) {}

  async getConfig(): Promise<Partial<SmsTunnelConfig>> {
    const row = await this.prisma.appSettings.findFirst();
    return {
      serverUrl: row?.smstunnelServerUrl || '',
      apiKey: row?.smstunnelApiKey || '',
      siteToken: row?.smstunnelSiteToken || '',
      deviceName: row?.smstunnelDeviceName || '',
    };
  }

  async updateConfig(partial: Partial<SmsTunnelConfig>): Promise<void> {
    await this.prisma.appSettings.updateMany({ data: partial });
  }

  async clearConfig(): Promise<void> {
    await this.prisma.appSettings.updateMany({
      data: { apiKey: '', deviceName: '', siteToken: '' },
    });
  }
}
```

#### JSON File

```typescript
import { SmsTunnelStorageAdapter, SmsTunnelConfig } from '@narcisbodea/smstunnel-sdk/server';
import { readFile, writeFile } from 'fs/promises';

export class JsonFileStorage implements SmsTunnelStorageAdapter {
  constructor(private filePath: string) {}

  async getConfig(): Promise<Partial<SmsTunnelConfig>> {
    try { return JSON.parse(await readFile(this.filePath, 'utf-8')); }
    catch { return {}; }
  }

  async updateConfig(partial: Partial<SmsTunnelConfig>): Promise<void> {
    const config = { ...(await this.getConfig()), ...partial };
    await writeFile(this.filePath, JSON.stringify(config, null, 2));
  }

  async clearConfig(): Promise<void> {
    await this.updateConfig({ apiKey: '', deviceName: '', siteToken: '' });
  }
}
```

### 2. Register the Module

```typescript
import { SmsTunnelModule } from '@narcisbodea/smstunnel-sdk/server';

@Module({
  imports: [
    SmsTunnelModule.forRoot({
      storage: new MongoSmsTunnelStorage(settingsModel),
      callbackBaseUrl: 'https://myapp.com/api',
      displayName: 'My App',
    }),
  ],
})
export class AppModule {}
```

Or async:

```typescript
SmsTunnelModule.forRootAsync({
  useFactory: (settingsModel) => ({
    storage: new MongoSmsTunnelStorage(settingsModel),
    callbackBaseUrl: process.env.CALLBACK_URL,
    displayName: 'My App',
  }),
  inject: [getModelToken('Settings')],
})
```

### Enterprise Mode (one app, several organizations)

If your application is used by several organizations and each organization links its own phone, also pass your Enterprise API key and the organization's ID:

```typescript
SmsTunnelModule.forRootAsync({
  useFactory: (settingsModel, tenantService) => ({
    storage: new MongoSmsTunnelStorage(settingsModel),
    callbackBaseUrl: process.env.CALLBACK_URL,
    displayName: 'My App',
    enterpriseApiKey: process.env.SMSTUNNEL_ENTERPRISE_API_KEY,
    externalId: tenantService.getCurrentTenantId(),
  }),
  inject: [getModelToken('Settings'), TenantService],
})
```

### 3. Auth (secure-by-default since v1.2.3)

> **Breaking change (v1.2.3):** The module now ships a built-in guard
> (`SmsTunnelAuthGuard`) that protects **every** route except the three
> public ones (`callback`, `pairing-status/:token`, the legacy WP callback).
> If you do **not** provide an auth strategy, all non-public routes are
> **blocked** (fail-closed) and a warning is logged at startup. Previously
> routes were open unless you wired up your own guard.

Provide an `authenticate(req)` predicate (recommended) — return `true` to
allow, `false`/throw to reject:

```typescript
SmsTunnelModule.forRoot({
  storage: new MongoSmsTunnelStorage(settingsModel),
  callbackBaseUrl: 'https://myapp.com/api',
  displayName: 'My App',
  // Secure-by-default: protect all non-public routes.
  authenticate: (req) => {
    // e.g. validate a session, JWT, API key, etc. on the raw request
    return Boolean(req.user) || isValidJwt(req.headers['authorization']);
  },
})
```

Or hand the module your own NestJS guard (no-arg constructor or instance):

```typescript
SmsTunnelModule.forRoot({
  /* ...storage, callbackBaseUrl... */
  authGuard: MyJwtAuthGuard, // class implementing CanActivate
})
```

The public routes are marked with `@SmsTunnelPublic()` and detected via
metadata (the `SMSTUNNEL_IS_PUBLIC_KEY` reflector key) — no URL string
matching.

**Legacy / app-level guard:** if you already protect these routes with your
own global guard using `SMSTUNNEL_PUBLIC_PATHS`, that still works. To avoid
double-auth you can pass `authenticate: () => true` so the built-in guard
defers to your global guard, while keeping the public routes open:

```typescript
import { SMSTUNNEL_PUBLIC_PATHS } from '@narcisbodea/smstunnel-sdk/server';

// In your global JwtAuthGuard:
if (SMSTUNNEL_PUBLIC_PATHS.some(p => request.url.includes(p))) return true;
```

### `update-config` / server URL is locked down (SSRF protection, v1.2.3)

`POST /smstunnel/update-config` (and `updateServerUrl()`) no longer accept an
arbitrary `serverUrl`. By default runtime override is **disabled** — set the
server URL server-side via the storage adapter. To allow runtime changes,
opt in explicitly and (optionally) extend the host allowlist:

```typescript
SmsTunnelModule.forRoot({
  /* ... */
  allowServerUrlOverride: true,           // default: false
  serverUrlAllowlist: ['smstunnel.io'],   // default; https only, no private IPs
})
```

Rejected: non-`https`, hosts outside the allowlist, and private/loopback/
link-local/metadata addresses. Invalid values are **not** persisted and the
route returns `400`.

### REST Endpoints

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `GET /smstunnel/status` | getStatus | Yes | Show pairing status |
| `POST /smstunnel/create-token` | createToken | Yes | Generate QR |
| `GET /smstunnel/pairing-status/:token` | pairingStatus | No | Polling proxy |
| `POST /smstunnel/callback` | callback | No | Receive API key |
| `POST /smstunnel/unpair` | unpair | Yes | Disconnect device |
| `POST /smstunnel/send` | sendSms | Yes | Send SMS |
| `POST /smstunnel/update-config` | updateConfig | Yes | Set server URL |
| `GET /smstunnel/e2e-status/:deviceId` | getDeviceE2EStatus | Yes | E2E encryption status |
| `GET /smstunnel/public-key/:deviceId` | getDevicePublicKey | Yes | Get device public key |
| `POST /smstunnel/verify-key` | verifyDeviceKey | Yes | Verify key fingerprint |
| `POST /smstunnel/send-encrypted` | sendEncryptedSms | Yes | Send encrypted SMS |
| `GET /smstunnel/pairings` | getPairings | Yes | List active pairings |

---

## React

Works with: **React, Next.js, Remix, Gatsby**

### Plug and Play Component

```tsx
import { SmsTunnelPairing, RO_LABELS } from '@narcisbodea/smstunnel-sdk/react';

function SettingsPage() {
  return (
    <SmsTunnelPairing
      apiBaseUrl="/api"
      getAuthHeaders={() => ({
        Authorization: `Bearer ${localStorage.getItem('token')}`,
      })}
      labels={RO_LABELS}
      onPaired={(device) => console.log('Paired:', device)}
      showTestSms={true}
      showServerUrlInput={true}
      qrSize={220}
    />
  );
}
```

### Next.js

Add `'use client'` in your page/component:

```tsx
'use client';
import { SmsTunnelPairing, RO_LABELS } from '@narcisbodea/smstunnel-sdk/react';

export default function SmsSettings() {
  return <SmsTunnelPairing apiBaseUrl="/api" labels={RO_LABELS} />;
}
```

### Custom UI with Hook

```tsx
import { useSmsTunnel, QrCodeCanvas } from '@narcisbodea/smstunnel-sdk/react';

function MySmsSettings() {
  const tunnel = useSmsTunnel({
    apiBaseUrl: '/api',
    getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
  });

  // E2E Encryption
  const e2eStatus = await tunnel.getDeviceE2EStatus('device-id');
  const publicKey = await tunnel.getDevicePublicKey('device-id');
  const keyValid = await tunnel.verifyDeviceKey('device-id', 'fingerprint');
  await tunnel.sendEncryptedSms('payload', 'device-id');

  if (tunnel.status === 'paired') {
    return <div>Connected: {tunnel.deviceName}</div>;
  }

  return (
    <div>
      {tunnel.showQr ? (
        <>
          <QrCodeCanvas value={tunnel.qrData} size={200} />
          <button onClick={tunnel.cancelPairing}>Cancel</button>
        </>
      ) : (
        <button onClick={tunnel.generateQr} disabled={tunnel.generating}>
          Connect Phone
        </button>
      )}
    </div>
  );
}
```

---

## Vue

Works with: **Vue 3, Nuxt 3**

### Plug and Play Component

```vue
<script setup>
import { SmsTunnelPairing, RO_LABELS } from '@narcisbodea/smstunnel-sdk/vue';

function onPaired(device) {
  console.log('Paired:', device);
}
</script>

<template>
  <SmsTunnelPairing
    api-base-url="/api"
    :labels="RO_LABELS"
    :show-test-sms="true"
    :show-server-url-input="true"
    @paired="onPaired"
  />
</template>
```

### Nuxt 3

Wrap in `<ClientOnly>` since pairing uses browser APIs:

```vue
<template>
  <ClientOnly>
    <SmsTunnelPairing api-base-url="/api" :labels="RO_LABELS" />
  </ClientOnly>
</template>

<script setup>
import { SmsTunnelPairing, RO_LABELS } from '@narcisbodea/smstunnel-sdk/vue';
</script>
```

### Custom UI with Composable

```vue
<script setup>
import { useSmsTunnel, QrCodeCanvas } from '@narcisbodea/smstunnel-sdk/vue';

const tunnel = useSmsTunnel({
  apiBaseUrl: '/api',
  getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
});

// E2E Encryption
const e2eStatus = await tunnel.getDeviceE2EStatus('device-id');
const publicKey = await tunnel.getDevicePublicKey('device-id');
await tunnel.sendEncryptedSms('payload', 'device-id');
</script>

<template>
  <div v-if="tunnel.status.value === 'paired'">
    Connected: {{ tunnel.deviceName.value }}
    <button @click="tunnel.unpair()">Disconnect</button>
  </div>
  <div v-else>
    <div v-if="tunnel.showQr.value">
      <QrCodeCanvas :value="tunnel.qrData.value" :size="200" />
      <button @click="tunnel.cancelPairing()">Cancel</button>
    </div>
    <button v-else @click="tunnel.generateQr()" :disabled="tunnel.generating.value">
      Connect Phone
    </button>
  </div>
</template>
```

---

## Angular

Works with: **Angular 17+** (standalone)

### Setup

```typescript
// app.config.ts
import { provideSmsTunnel } from '@narcisbodea/smstunnel-sdk/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideSmsTunnel({
      apiBaseUrl: 'https://your-backend.com',
      getAuthHeaders: () => ({
        Authorization: `Bearer ${localStorage.getItem('token')}`,
      }),
    }),
  ],
};
```

### Usage

```typescript
import { Component, inject } from '@angular/core';
import { SmsTunnelService } from '@narcisbodea/smstunnel-sdk/angular';

@Component({ /* ... */ })
export class SmsPairingComponent {
  private sms = inject(SmsTunnelService);

  async connect() {
    // Pairing
    const status = await this.sms.getStatus();
    const token = await this.sms.createToken();
    const pairings = await this.sms.getPairings();
    await this.sms.unpair();

    // SMS
    await this.sms.sendSms('+40721123456', 'Hello!');
    await this.sms.send2fa('+40721123456', '123456');
    await this.sms.sendBulk([{ to: '+40721111111', message: 'Hi' }]); // several recipients, max 100
    const msgStatus = await this.sms.getSmsStatus('msg-id');
    // Received SMS need a key you explicitly allowed to read them; QR-pairing keys cannot.
    const received = await this.sms.getReceivedSms();

    // Devices
    const devices = await this.sms.getDevices();
    const usage = await this.sms.getUsage();

    // E2E Encryption
    const e2eStatus = await this.sms.getDeviceE2EStatus('device-id');
    const publicKey = await this.sms.getDevicePublicKey('device-id');
    const verification = await this.sms.verifyDeviceKey('device-id', 'fingerprint');
    await this.sms.sendEncryptedSms('payload', 'device-id');
  }
}
```

---

## Svelte

```svelte
<script>
  import { SmsTunnelClient } from '@narcisbodea/smstunnel-sdk';
  import { onMount, onDestroy } from 'svelte';

  let status = 'loading';
  let qrData = '';
  let deviceName = '';

  const client = new SmsTunnelClient({
    apiBaseUrl: '/api',
    getAuthHeaders: () => ({
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    }),
  });

  onMount(async () => {
    const s = await client.getStatus();
    status = s.paired ? 'paired' : 'unpaired';
    deviceName = s.deviceName || '';
  });

  onDestroy(() => client.destroy());

  async function connect() {
    const result = await client.createToken();
    if (result.success) {
      qrData = result.qrData;
      client.startPolling(result.token, async (event) => {
        if (event === 'completed') {
          const s = await client.getStatus();
          status = 'paired';
          deviceName = s.deviceName || '';
        }
      });
    }
  }
</script>

{#if status === 'paired'}
  <p>Connected: {deviceName}</p>
  <button on:click={() => client.unpair()}>Disconnect</button>
{:else}
  <button on:click={connect}>Connect Phone</button>
{/if}
```

---

## Astro

Astro supports React, Vue, and Svelte islands. Use any of the above:

```astro
---
// pages/settings.astro
---
<script>
  import { SmsTunnelPairing, RO_LABELS } from '@narcisbodea/smstunnel-sdk/react';
</script>

<SmsTunnelPairing client:only="react" apiBaseUrl="/api" labels={RO_LABELS} />
```

Or with Vue:

```astro
<SmsTunnelPairing client:only="vue" api-base-url="/api" />
```

---

## E2E Encryption

All SDKs support end-to-end encryption using RSA-2048. The device holds the private key, the server stores the public key.

### Flow

1. Check if device has E2E enabled: `getDeviceE2EStatus(deviceId)`
2. Get the device's public key: `getDevicePublicKey(deviceId)`
3. Encrypt your message with the RSA public key (client-side)
4. Send encrypted: `sendEncryptedSms(encryptedPayload, deviceId)`
5. Device decrypts with its private key

### Key Verification

Store the `publicKeyFingerprint` locally after first pairing. Before sending, verify it hasn't changed:

```typescript
const result = await client.verifyDeviceKey('device-id', 'stored-fingerprint');
if (result.needsRePairing) {
  // Device was reinstalled, key changed - need to re-pair
}
```

---

## SmsTunnelClient API (framework-agnostic)

```typescript
import { SmsTunnelClient } from '@narcisbodea/smstunnel-sdk';

const client = new SmsTunnelClient({
  apiBaseUrl: '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer ...' }),
  routePrefix: 'smstunnel', // default
  pollInterval: 3000,       // default
});

// Pairing
await client.getStatus();                    // { paired, serverUrl, deviceName }
await client.createToken();                  // { success, token, qrData, ... }
await client.getPairingStatus(token);        // { status, displayName }
client.startPolling(token, (event) => ...);  // returns cleanup fn
client.stopPolling();
await client.unpair();

// SMS
await client.sendSms('+40741234567', 'Hi');
await client.updateServerUrl('https://...');

// E2E Encryption
await client.getDeviceE2EStatus('device-id');
await client.getDevicePublicKey('device-id');
await client.verifyDeviceKey('device-id', 'fingerprint');
await client.sendEncryptedSms('payload', 'device-id');

client.destroy();                            // cleanup
```

---

## Labels (i18n)

Built-in presets: `EN_LABELS` (default), `RO_LABELS`.

Available from any import path:
```typescript
import { EN_LABELS, RO_LABELS } from '@narcisbodea/smstunnel-sdk';
import { EN_LABELS, RO_LABELS } from '@narcisbodea/smstunnel-sdk/react';
import { EN_LABELS, RO_LABELS } from '@narcisbodea/smstunnel-sdk/vue';
```

Custom labels: implement the `SmsTunnelLabels` interface.

---

## Exports Summary

| Path | Exports |
|------|---------|
| `@narcisbodea/smstunnel-sdk` | `SmsTunnelClient`, `EN_LABELS`, `RO_LABELS`, types |
| `@narcisbodea/smstunnel-sdk/server` | `SmsTunnelModule`, `SmsTunnelService`, `SmsTunnelAuthGuard`, `SmsTunnelPublic`, `SMSTUNNEL_PUBLIC_PATHS` |
| `@narcisbodea/smstunnel-sdk/react` | `SmsTunnelPairing`, `QrCodeCanvas`, `useSmsTunnel` |
| `@narcisbodea/smstunnel-sdk/vue` | `SmsTunnelPairing`, `QrCodeCanvas`, `useSmsTunnel` |
| `@narcisbodea/smstunnel-sdk/angular` | `SmsTunnelService`, `provideSmsTunnel`, `SMSTUNNEL_CONFIG` |
| `@narcisbodea/smstunnel-sdk/node` | `SmsTunnelNodeClient` |

## License

MIT
