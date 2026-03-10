// Re-export shared labels
export type { SmsTunnelLabels } from '../shared/labels';
export { EN_LABELS, RO_LABELS } from '../shared/labels';

export interface SmsTunnelPairingProps {
  apiBaseUrl: string;
  getAuthHeaders?: () => Record<string, string>;
  labels?: import('../shared/labels').SmsTunnelLabels;
  onPaired?: (device: { deviceName: string }) => void;
  onUnpaired?: () => void;
  showTestSms?: boolean;
  showServerUrlInput?: boolean;
  qrSize?: number;
  routePrefix?: string;
  className?: string;
}

export interface UseSmsTunnelOptions {
  apiBaseUrl: string;
  getAuthHeaders?: () => Record<string, string>;
  routePrefix?: string;
  pollInterval?: number;
}

export interface SmsTunnelState {
  status: 'loading' | 'unpaired' | 'paired';
  serverUrl: string;
  deviceName: string;
  showQr: boolean;
  qrData: string;
  generating: boolean;
  polling: boolean;
  error: string;
}
