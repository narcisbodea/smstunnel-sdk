export { SmsTunnelModule } from './smstunnel.module';
export { SmsTunnelService } from './smstunnel.service';
export { SmsTunnelController } from './smstunnel.controller';
export { SmsTunnelAuthGuard } from './smstunnel.guard';
export {
  SmsTunnelPublic,
  SMSTUNNEL_IS_PUBLIC_KEY,
} from './smstunnel.public.decorator';
export {
  SMSTUNNEL_OPTIONS,
  SMSTUNNEL_PUBLIC_PATHS,
  SMSTUNNEL_DEFAULT_PREFIX,
  getSmsTunnelPublicPaths,
} from './smstunnel.constants';
export type {
  SmsTunnelConfig,
  SmsTunnelStorageAdapter,
  SmsTunnelModuleOptions,
  SmsTunnelModuleAsyncOptions,
  CanActivateLike,
  SmsTunnelStatus,
  SendSmsResult,
  CreateTokenResult,
  PairingStatusResult,
  PairingCallbackBody,
  LegacyCallbackBody,
  SaasActivateResult,
  DeviceE2EStatus,
  DevicePublicKeyInfo,
  VerifyDeviceKeyResult,
} from './smstunnel.interfaces';

// ─── E2E encryptors (Node-only; safe to import server-side) ───────────────────
export {
  encryptPayload,
  encryptPayloadV1,
  encryptPayloadV2,
  decryptPayload,
} from '../shared/e2e-crypto';
export type {
  E2eVersion,
  E2eHybridEnvelope,
  EncryptPayloadOptions,
} from '../shared/e2e-crypto';
export {
  certificateFingerprint,
  createCertificate,
  openCertificate,
  sealText,
} from '../shared/sealed-crypto';
export type { SealedCertificate, SealedCertificateFile } from '../shared/sealed-crypto';
