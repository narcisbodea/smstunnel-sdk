// Re-export shared labels
export type { SmsTunnelLabels } from '../shared/labels';
export { EN_LABELS, RO_LABELS } from '../shared/labels';

export interface SmsTunnelPairingProps {
  apiBaseUrl: string;
  /** Return the current JWT/auth token. SDK adds Authorization: Bearer header automatically. */
  getToken?: () => string | null;
  /** Full control over auth headers. Takes precedence over getToken. */
  getAuthHeaders?: () => Record<string, string>;
  labels?: import('../shared/labels').SmsTunnelLabels;
  onPaired?: (device: { deviceName: string }) => void;
  onUnpaired?: () => void;
  showTestSms?: boolean;
  showServerUrlInput?: boolean;
  qrSize?: number;
  className?: string;
}

export interface UseSmsTunnelOptions {
  apiBaseUrl: string;
  /** Return the current JWT/auth token. SDK adds Authorization: Bearer header automatically. */
  getToken?: () => string | null;
  /** Full control over auth headers. Takes precedence over getToken. */
  getAuthHeaders?: () => Record<string, string>;
  pollInterval?: number;
}

export interface SmsTunnelState {
  status: 'loading' | 'unpaired' | 'paired';
  serverUrl: string;
  deviceName: string;
  showQr: boolean;
  qrData: string;
  pairingCode: string;
  generating: boolean;
  polling: boolean;
  error: string;
}
