import { useState, useEffect, useRef, useCallback } from 'react';
import type { SmsTunnelState, UseSmsTunnelOptions } from './types';

export function useSmsTunnel(options: UseSmsTunnelOptions) {
  const { apiBaseUrl, getAuthHeaders, pollInterval = 3000 } = options;
  const routePrefix = 'smstunnel';

  const [state, setState] = useState<SmsTunnelState>({
    status: 'loading',
    serverUrl: '',
    deviceName: '',
    showQr: false,
    qrData: '',
    generating: false,
    polling: false,
    error: '',
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingTokenRef = useRef<string>('');

  const baseUrl = apiBaseUrl.replace(/\/$/, '');

  const authHeaders = useCallback((): Record<string, string> => {
    return getAuthHeaders ? getAuthHeaders() : {};
  }, [getAuthHeaders]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/status`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setState((prev) => ({
        ...prev,
        status: data.paired ? 'paired' : 'unpaired',
        serverUrl: data.serverUrl || '',
        deviceName: data.deviceName || '',
      }));
    } catch {
      setState((prev) => ({ ...prev, status: 'unpaired' }));
    }
  }, [baseUrl, routePrefix, authHeaders]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling effect
  useEffect(() => {
    if (!state.polling || !pairingTokenRef.current) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${baseUrl}/${routePrefix}/pairing-status/${pairingTokenRef.current}`,
        );
        const data = await res.json();

        if (data.status === 'completed') {
          setState((prev) => ({ ...prev, polling: false, showQr: false }));
          if (pollRef.current) clearInterval(pollRef.current);
          // Wait for callback to arrive, then refetch
          setTimeout(() => fetchStatus(), 2000);
        } else if (data.status === 'expired') {
          setState((prev) => ({
            ...prev,
            polling: false,
            showQr: false,
            error: 'QR code expired',
          }));
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // ignore polling errors
      }
    }, pollInterval);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state.polling, baseUrl, routePrefix, pollInterval, fetchStatus]);

  const generateQr = useCallback(async () => {
    setState((prev) => ({ ...prev, generating: true, error: '' }));
    try {
      const res = await fetch(`${baseUrl}/${routePrefix}/create-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
      });
      const data = await res.json();

      if (!data.success) {
        setState((prev) => ({
          ...prev,
          generating: false,
          error: data.error || 'Failed to create QR code',
        }));
        return;
      }

      pairingTokenRef.current = data.token;
      setState((prev) => ({
        ...prev,
        qrData: data.qrData,
        showQr: true,
        polling: true,
        generating: false,
      }));
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        generating: false,
        error: `Error: ${err.message}`,
      }));
    }
  }, [baseUrl, routePrefix, authHeaders]);

  const cancelPairing = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pairingTokenRef.current = '';
    setState((prev) => ({
      ...prev,
      showQr: false,
      polling: false,
      qrData: '',
    }));
  }, []);

  const unpair = useCallback(async () => {
    try {
      await fetch(`${baseUrl}/${routePrefix}/unpair`, {
        method: 'POST',
        headers: authHeaders(),
      });
      setState((prev) => ({
        ...prev,
        status: 'unpaired',
        deviceName: '',
      }));
    } catch (err: any) {
      setState((prev) => ({ ...prev, error: `Unpair failed: ${err.message}` }));
    }
  }, [baseUrl, routePrefix, authHeaders]);

  const sendTestSms = useCallback(
    async (to: string, message: string) => {
      try {
        const res = await fetch(`${baseUrl}/${routePrefix}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({ to, message }),
        });
        return (await res.json()) as { success: boolean; messageId?: string; error?: string };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [baseUrl, routePrefix, authHeaders],
  );

  const updateServerUrl = useCallback(
    async (serverUrl: string) => {
      try {
        await fetch(`${baseUrl}/${routePrefix}/update-config`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({ serverUrl }),
        });
        setState((prev) => ({ ...prev, serverUrl }));
      } catch (err: any) {
        setState((prev) => ({ ...prev, error: `Update failed: ${err.message}` }));
      }
    },
    [baseUrl, routePrefix, authHeaders],
  );

  const refetch = useCallback(() => fetchStatus(), [fetchStatus]);

  // ─── E2E Encryption ────────────────────────────────

  const getDeviceE2EStatus = useCallback(
    async (deviceId: string) => {
      try {
        const res = await fetch(
          `${baseUrl}/${routePrefix}/e2e-status/${deviceId}`,
          { headers: authHeaders() },
        );
        return await res.json();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [baseUrl, routePrefix, authHeaders],
  );

  const getDevicePublicKey = useCallback(
    async (deviceId: string) => {
      try {
        const res = await fetch(
          `${baseUrl}/${routePrefix}/public-key/${deviceId}`,
          { headers: authHeaders() },
        );
        return await res.json();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [baseUrl, routePrefix, authHeaders],
  );

  const verifyDeviceKey = useCallback(
    async (deviceId: string, fingerprint: string) => {
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
    },
    [baseUrl, routePrefix, authHeaders],
  );

  const sendEncryptedSms = useCallback(
    async (encryptedPayload: string, deviceId: string, is2FA: boolean = false) => {
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
    },
    [baseUrl, routePrefix, authHeaders],
  );

  return {
    ...state,
    generateQr,
    cancelPairing,
    unpair,
    sendTestSms,
    updateServerUrl,
    refetch,
    // E2E
    getDeviceE2EStatus,
    getDevicePublicKey,
    verifyDeviceKey,
    sendEncryptedSms,
  };
}
