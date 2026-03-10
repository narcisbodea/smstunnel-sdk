import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { SmsTunnelLabels } from '../shared/labels';

export interface UseSmsTunnelOptions {
  apiBaseUrl: string;
  getAuthHeaders?: () => Record<string, string>;
  routePrefix?: string;
  pollInterval?: number;
}

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export function useSmsTunnel(options: UseSmsTunnelOptions) {
  const {
    apiBaseUrl,
    getAuthHeaders,
    routePrefix = 'smstunnel',
    pollInterval = 3000,
  } = options;

  const baseUrl = apiBaseUrl.replace(/\/$/, '');

  const status = ref<'loading' | 'unpaired' | 'paired'>('loading');
  const serverUrl = ref('');
  const deviceName = ref('');
  const showQr = ref(false);
  const qrData = ref('');
  const generating = ref(false);
  const polling = ref(false);
  const error = ref('');

  let pairingToken = '';
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function authHeaders(): Record<string, string> {
    return getAuthHeaders ? getAuthHeaders() : {};
  }

  async function fetchStatus() {
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/status`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      status.value = data.paired ? 'paired' : 'unpaired';
      serverUrl.value = data.serverUrl || '';
      deviceName.value = data.deviceName || '';
    } catch {
      status.value = 'unpaired';
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!pairingToken) return;
      try {
        const res = await fetch(
          `${baseUrl}/${routePrefix}/pairing-status/${pairingToken}`,
        );
        const data = await res.json();
        if (data.status === 'completed') {
          polling.value = false;
          showQr.value = false;
          stopPolling();
          setTimeout(() => fetchStatus(), 2000);
        } else if (data.status === 'expired') {
          polling.value = false;
          showQr.value = false;
          error.value = 'QR code expired';
          stopPolling();
        }
      } catch {
        // ignore
      }
    }, pollInterval);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  watch(polling, (val) => {
    if (val) startPolling();
    else stopPolling();
  });

  async function generateQr() {
    generating.value = true;
    error.value = '';
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/create-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      const data = await res.json();
      if (!data.success) {
        error.value = data.error || 'Failed to create QR code';
        generating.value = false;
        return;
      }
      pairingToken = data.token;
      qrData.value = data.qrData;
      showQr.value = true;
      polling.value = true;
    } catch (err: any) {
      error.value = `Error: ${err.message}`;
    } finally {
      generating.value = false;
    }
  }

  function cancelPairing() {
    stopPolling();
    pairingToken = '';
    showQr.value = false;
    polling.value = false;
    qrData.value = '';
  }

  async function unpair() {
    try {
      await fetch(`${baseUrl}/${routePrefix}/unpair`, {
        method: 'POST',
        headers: authHeaders(),
      });
      status.value = 'unpaired';
      deviceName.value = '';
    } catch (err: any) {
      error.value = `Unpair failed: ${err.message}`;
    }
  }

  async function sendTestSms(to: string, message: string): Promise<SendSmsResult> {
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ to, message }),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async function updateServerUrl(url: string) {
    try {
      await fetch(`${baseUrl}/${routePrefix}/update-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ serverUrl: url }),
      });
      serverUrl.value = url;
    } catch (err: any) {
      error.value = `Update failed: ${err.message}`;
    }
  }

  // ─── E2E Encryption ────────────────────────────────

  async function getDeviceE2EStatus(deviceId: string) {
    try {
      const res = await fetch(
        `${baseUrl}/${routePrefix}/e2e-status/${deviceId}`,
        { headers: authHeaders() },
      );
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async function getDevicePublicKey(deviceId: string) {
    try {
      const res = await fetch(
        `${baseUrl}/${routePrefix}/public-key/${deviceId}`,
        { headers: authHeaders() },
      );
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async function verifyDeviceKey(deviceId: string, fingerprint: string) {
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/verify-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ deviceId, fingerprint }),
      });
      return await res.json();
    } catch (err: any) {
      return { valid: false, needsRePairing: true, error: err.message };
    }
  }

  async function sendEncryptedSms(encryptedPayload: string, deviceId: string, is2FA: boolean = false) {
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/send-encrypted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ encryptedPayload, deviceId, is2FA }),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  onMounted(() => fetchStatus());
  onUnmounted(() => stopPolling());

  return {
    status,
    serverUrl,
    deviceName,
    showQr,
    qrData,
    generating,
    polling,
    error,
    generateQr,
    cancelPairing,
    unpair,
    sendTestSms,
    updateServerUrl,
    refetch: fetchStatus,
    // E2E
    getDeviceE2EStatus,
    getDevicePublicKey,
    verifyDeviceKey,
    sendEncryptedSms,
  };
}
