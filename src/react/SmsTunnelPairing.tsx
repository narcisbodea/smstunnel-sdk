import { useState } from 'react';
import { useSmsTunnel } from './useSmsTunnel';
import { QrCodeCanvas } from './QrCodeCanvas';
import { EN_LABELS } from './types';
import type { SmsTunnelPairingProps } from './types';

// Inline styles - no external CSS dependency
const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '14px',
    color: '#1f2937',
  } as React.CSSProperties,
  card: {
    border: '1px solid #e5e7eb',
    borderRadius: '12px',
    padding: '24px',
    backgroundColor: '#ffffff',
  } as React.CSSProperties,
  title: {
    fontSize: '18px',
    fontWeight: 600,
    color: '#111827',
    marginBottom: '4px',
  } as React.CSSProperties,
  subtitle: {
    fontSize: '13px',
    color: '#6b7280',
    marginBottom: '20px',
  } as React.CSSProperties,
  section: {
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
  } as React.CSSProperties,
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    color: '#374151',
    marginBottom: '6px',
  } as React.CSSProperties,
  inputRow: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  input: {
    flex: 1,
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    outline: 'none',
  } as React.CSSProperties,
  button: {
    padding: '6px 16px',
    borderRadius: '8px',
    border: 'none',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: '#4f46e5',
    color: '#ffffff',
    transition: 'opacity 0.2s',
  } as React.CSSProperties,
  buttonSecondary: {
    padding: '6px 16px',
    borderRadius: '8px',
    border: '1px solid #d1d5db',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: '#ffffff',
    color: '#374151',
  } as React.CSSProperties,
  buttonDanger: {
    padding: '6px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: '#9ca3af',
    transition: 'color 0.2s',
  } as React.CSSProperties,
  pairedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    border: '1px solid #bbf7d0',
    backgroundColor: '#f0fdf4',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
  } as React.CSSProperties,
  pairedIcon: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: '#dcfce7',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#16a34a',
    fontSize: '18px',
    flexShrink: 0,
  } as React.CSSProperties,
  unpairedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    border: '1px solid #fde68a',
    backgroundColor: '#fefce8',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
  } as React.CSSProperties,
  qrContainer: {
    textAlign: 'center' as const,
    padding: '16px',
  } as React.CSSProperties,
  qrFrame: {
    display: 'inline-block',
    border: '2px dashed #a5b4fc',
    borderRadius: '12px',
    padding: '16px',
    backgroundColor: '#ffffff',
    marginBottom: '12px',
  } as React.CSSProperties,
  spinner: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    border: '2px solid #d1d5db',
    borderTopColor: '#4f46e5',
    borderRadius: '50%',
    animation: 'smstunnel-spin 0.8s linear infinite',
    marginRight: '8px',
    verticalAlign: 'middle',
  } as React.CSSProperties,
  error: {
    color: '#dc2626',
    fontSize: '13px',
    marginBottom: '12px',
  } as React.CSSProperties,
  success: {
    color: '#16a34a',
    fontSize: '12px',
    marginTop: '8px',
  } as React.CSSProperties,
  errorSmall: {
    color: '#dc2626',
    fontSize: '12px',
    marginTop: '8px',
  } as React.CSSProperties,
};

// Inject keyframes once
let stylesInjected = false;
function injectKeyframes() {
  if (stylesInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `@keyframes smstunnel-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
  stylesInjected = true;
}

export function SmsTunnelPairing({
  apiBaseUrl,
  getAuthHeaders,
  labels = EN_LABELS,
  onPaired,
  onUnpaired,
  showTestSms = true,
  showServerUrlInput = true,
  qrSize = 220,
  routePrefix = 'smstunnel',
  className,
}: SmsTunnelPairingProps) {
  injectKeyframes();

  const tunnel = useSmsTunnel({ apiBaseUrl, getAuthHeaders, routePrefix });

  const [localServerUrl, setLocalServerUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testMsg, setTestMsg] = useState('Test SMS');
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    messageId?: string;
  } | null>(null);
  const [sendingTest, setSendingTest] = useState(false);

  // Sync server URL once loaded
  if (tunnel.serverUrl && !localServerUrl) {
    setLocalServerUrl(tunnel.serverUrl);
  }

  const handleSaveUrl = async () => {
    if (!localServerUrl.trim()) return;
    setSavingUrl(true);
    await tunnel.updateServerUrl(localServerUrl.trim().replace(/\/$/, ''));
    setSavingUrl(false);
  };

  const handleUnpair = async () => {
    if (!confirm(labels.unpairConfirm)) return;
    await tunnel.unpair();
    onUnpaired?.();
  };

  const handleGenerateQr = async () => {
    await tunnel.generateQr();
  };

  // Watch for pairing completion
  const prevStatus = tunnel.status;
  if (prevStatus === 'paired' && tunnel.deviceName) {
    // Fire onPaired if status changed
  }

  const handleTestSms = async () => {
    if (!testPhone.trim()) return;
    setSendingTest(true);
    setTestResult(null);
    const result = await tunnel.sendTestSms(testPhone.trim(), testMsg);
    setTestResult(result);
    setSendingTest(false);
  };

  if (tunnel.status === 'loading') {
    return (
      <div style={styles.container} className={className}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '24px' }}>
            <span style={styles.spinner} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container} className={className}>
      <div style={styles.card}>
        <div style={styles.title}>{labels.title}</div>
        <div style={styles.subtitle}>{labels.description}</div>

        {/* Server URL */}
        {showServerUrlInput && (
          <div style={styles.section}>
            <label style={styles.label}>{labels.serverUrlLabel}</label>
            <div style={styles.inputRow}>
              <input
                value={localServerUrl}
                onChange={(e) => setLocalServerUrl(e.target.value)}
                placeholder={labels.serverUrlPlaceholder}
                style={styles.input}
              />
              <button
                style={{
                  ...styles.button,
                  opacity: savingUrl || !localServerUrl.trim() ? 0.5 : 1,
                }}
                onClick={handleSaveUrl}
                disabled={savingUrl || !localServerUrl.trim()}
              >
                {labels.saveButton}
              </button>
            </div>
          </div>
        )}

        {tunnel.error && <div style={styles.error}>{tunnel.error}</div>}

        {tunnel.status === 'paired' ? (
          <div>
            {/* Paired banner */}
            <div style={styles.pairedBanner}>
              <div style={styles.pairedIcon}>&#10003;</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#166534' }}>
                  {labels.pairedStatus}
                </div>
                <div style={{ fontSize: '12px', color: '#16a34a' }}>
                  {labels.deviceLabel}: {tunnel.deviceName || 'Android Phone'}
                </div>
              </div>
              <button
                onClick={handleUnpair}
                style={styles.buttonDanger}
                title={labels.unpairButton}
              >
                &#10005;
              </button>
            </div>

            {/* Test SMS */}
            {showTestSms && (
              <div style={styles.section}>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#374151',
                    marginBottom: '12px',
                  }}
                >
                  {labels.testSmsTitle}
                </div>
                <div style={styles.inputRow}>
                  <input
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    placeholder={labels.testPhonePlaceholder}
                    style={styles.input}
                  />
                  <input
                    value={testMsg}
                    onChange={(e) => setTestMsg(e.target.value)}
                    placeholder={labels.testMessagePlaceholder}
                    style={styles.input}
                  />
                  <button
                    style={{
                      ...styles.button,
                      opacity: sendingTest || !testPhone.trim() ? 0.5 : 1,
                    }}
                    onClick={handleTestSms}
                    disabled={sendingTest || !testPhone.trim()}
                  >
                    {sendingTest ? (
                      <span style={styles.spinner} />
                    ) : (
                      labels.sendTestButton
                    )}
                  </button>
                </div>
                {testResult && (
                  <div style={testResult.success ? styles.success : styles.errorSmall}>
                    {testResult.success
                      ? `${labels.smsSentSuccess} (ID: ${testResult.messageId})`
                      : `${labels.smsError}: ${testResult.error}`}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            {/* Not paired banner */}
            <div style={styles.unpairedBanner}>
              <div style={{ fontSize: '24px' }}>&#128241;</div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#854d0e' }}>
                  {labels.notPairedStatus}
                </div>
                <div style={{ fontSize: '12px', color: '#a16207' }}>
                  {labels.notPairedDescription}
                </div>
              </div>
            </div>

            {!tunnel.showQr ? (
              <button
                style={{
                  ...styles.button,
                  opacity: tunnel.generating ? 0.5 : 1,
                }}
                onClick={handleGenerateQr}
                disabled={tunnel.generating}
              >
                {tunnel.generating && <span style={styles.spinner} />}
                {labels.connectButton}
              </button>
            ) : (
              <div style={styles.qrContainer}>
                <div style={{ fontSize: '13px', color: '#4b5563', marginBottom: '12px' }}>
                  {labels.scanQrPrompt}
                </div>
                <div style={styles.qrFrame}>
                  <QrCodeCanvas value={tunnel.qrData} size={qrSize} />
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    fontSize: '12px',
                    color: '#9ca3af',
                    marginBottom: '12px',
                  }}
                >
                  <span style={styles.spinner} />
                  {labels.waitingForPairing}
                </div>
                <button style={styles.buttonSecondary} onClick={tunnel.cancelPairing}>
                  {labels.cancelButton}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
