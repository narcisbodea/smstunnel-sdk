// Common types shared between server and all frontends
export type {
  SmsTunnelConfig,
  SmsTunnelStorageAdapter,
  SmsTunnelStatus,
  SendSmsResult,
  CreateTokenResult,
  PairingStatusResult,
  PairingCallbackBody,
} from './server/smstunnel.interfaces';

// Shared labels (i18n)
export type { SmsTunnelLabels } from './shared/labels';
export { EN_LABELS, RO_LABELS } from './shared/labels';

// Framework-agnostic client (Angular, Svelte, Astro, Solid, Vanilla JS)
export { SmsTunnelClient } from './client';
export type {
  SmsTunnelClientOptions,
  SmsTunnelStatusResponse,
  CreateTokenResponse,
  PairingStatusResponse,
  SendSmsResponse,
  SmsStatusResponse,
  SendBulkSmsRequest,
  SendBulkSmsResponse,
  Send2faRequest,
  ReceivedSmsResponse,
  DevicesResponse,
  AccountUsageResponse,
  PairingInfo,
  PairingEventCallback,
  DeviceE2EStatusResponse,
  DevicePublicKeyResponse,
  VerifyDeviceKeyResponse,
} from './client';
