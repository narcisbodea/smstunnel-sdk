import { defineComponent, ref, watch, h, type PropType } from 'vue';
import { useSmsTunnel } from './useSmsTunnel';
import { QrCodeCanvas } from './QrCodeCanvas';
import { EN_LABELS, type SmsTunnelLabels } from '../shared/labels';

// Inline styles (same as React version - no CSS dependency)
const s = {
  container: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontSize: '14px', color: '#1f2937' },
  card: { border: '1px solid #e5e7eb', borderRadius: '12px', padding: '24px', backgroundColor: '#ffffff' },
  title: { fontSize: '18px', fontWeight: '600', color: '#111827', marginBottom: '4px' },
  subtitle: { fontSize: '13px', color: '#6b7280', marginBottom: '20px' },
  section: { border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', marginBottom: '16px' },
  label: { display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' },
  inputRow: { display: 'flex', gap: '8px' },
  input: { flex: '1', border: '1px solid #d1d5db', borderRadius: '8px', padding: '6px 12px', fontSize: '13px', outline: 'none' },
  button: { padding: '6px 16px', borderRadius: '8px', border: 'none', fontSize: '13px', fontWeight: '500', cursor: 'pointer', backgroundColor: '#4f46e5', color: '#ffffff' },
  buttonSecondary: { padding: '6px 16px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '13px', fontWeight: '500', cursor: 'pointer', backgroundColor: '#ffffff', color: '#374151' },
  pairedBanner: { display: 'flex', alignItems: 'center', gap: '12px', border: '1px solid #bbf7d0', backgroundColor: '#f0fdf4', borderRadius: '8px', padding: '16px', marginBottom: '16px' },
  pairedIcon: { width: '40px', height: '40px', borderRadius: '50%', backgroundColor: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16a34a', fontSize: '18px', flexShrink: '0' },
  unpairedBanner: { display: 'flex', alignItems: 'center', gap: '12px', border: '1px solid #fde68a', backgroundColor: '#fefce8', borderRadius: '8px', padding: '16px', marginBottom: '16px' },
  qrContainer: { textAlign: 'center', padding: '16px' } as Record<string, string>,
  qrFrame: { display: 'inline-block', border: '2px dashed #a5b4fc', borderRadius: '12px', padding: '16px', backgroundColor: '#ffffff', marginBottom: '12px' },
  spinner: { display: 'inline-block', width: '12px', height: '12px', border: '2px solid #d1d5db', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'smstunnel-spin 0.8s linear infinite', marginRight: '8px', verticalAlign: 'middle' },
  error: { color: '#dc2626', fontSize: '13px', marginBottom: '12px' },
  success: { color: '#16a34a', fontSize: '12px', marginTop: '8px' },
  errorSmall: { color: '#dc2626', fontSize: '12px', marginTop: '8px' },
};

let stylesInjected = false;
function injectKeyframes() {
  if (stylesInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = '@keyframes smstunnel-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
  stylesInjected = true;
}

export const SmsTunnelPairing = defineComponent({
  name: 'SmsTunnelPairing',
  props: {
    apiBaseUrl: { type: String, required: true },
    getAuthHeaders: { type: Function as PropType<() => Record<string, string>>, default: undefined },
    labels: { type: Object as PropType<SmsTunnelLabels>, default: () => EN_LABELS },
    showTestSms: { type: Boolean, default: true },
    showServerUrlInput: { type: Boolean, default: true },
    qrSize: { type: Number, default: 220 },
  },
  emits: ['paired', 'unpaired'],
  setup(props, { emit }) {
    injectKeyframes();

    const tunnel = useSmsTunnel({
      apiBaseUrl: props.apiBaseUrl,
      getAuthHeaders: props.getAuthHeaders,
    });

    const localServerUrl = ref('');
    const savingUrl = ref(false);
    const testPhone = ref('');
    const testMsg = ref('Test SMS');
    const testResult = ref<{ success: boolean; error?: string; messageId?: string } | null>(null);
    const sendingTest = ref(false);

    watch(tunnel.serverUrl, (val) => {
      if (val && !localServerUrl.value) localServerUrl.value = val;
    }, { immediate: true });

    watch(tunnel.status, (val, old) => {
      if (val === 'paired' && old !== 'paired') {
        emit('paired', { deviceName: tunnel.deviceName.value });
      }
    });

    async function saveUrl() {
      if (!localServerUrl.value.trim()) return;
      savingUrl.value = true;
      await tunnel.updateServerUrl(localServerUrl.value.trim().replace(/\/$/, ''));
      savingUrl.value = false;
    }

    async function handleUnpair() {
      if (!confirm(props.labels.unpairConfirm)) return;
      await tunnel.unpair();
      emit('unpaired');
    }

    async function handleTestSms() {
      if (!testPhone.value.trim()) return;
      sendingTest.value = true;
      testResult.value = null;
      testResult.value = await tunnel.sendTestSms(testPhone.value.trim(), testMsg.value);
      sendingTest.value = false;
    }

    return () => {
      const L = props.labels;

      if (tunnel.status.value === 'loading') {
        return h('div', { style: s.container }, [
          h('div', { style: s.card }, [
            h('div', { style: { textAlign: 'center', padding: '24px' } }, [
              h('span', { style: s.spinner }),
            ]),
          ]),
        ]);
      }

      const children: any[] = [];

      // Title
      children.push(h('div', { style: s.title }, L.title));
      children.push(h('div', { style: s.subtitle }, L.description));

      // Server URL
      if (props.showServerUrlInput) {
        children.push(
          h('div', { style: s.section }, [
            h('label', { style: s.label }, L.serverUrlLabel),
            h('div', { style: s.inputRow }, [
              h('input', {
                value: localServerUrl.value,
                onInput: (e: Event) => { localServerUrl.value = (e.target as HTMLInputElement).value; },
                placeholder: L.serverUrlPlaceholder,
                style: s.input,
              }),
              h('button', {
                style: { ...s.button, opacity: savingUrl.value || !localServerUrl.value.trim() ? '0.5' : '1' },
                onClick: saveUrl,
                disabled: savingUrl.value || !localServerUrl.value.trim(),
              }, L.saveButton),
            ]),
          ]),
        );
      }

      // Error
      if (tunnel.error.value) {
        children.push(h('div', { style: s.error }, tunnel.error.value));
      }

      if (tunnel.status.value === 'paired') {
        // Paired banner
        children.push(
          h('div', { style: s.pairedBanner }, [
            h('div', { style: s.pairedIcon }, '\u2713'),
            h('div', { style: { flex: '1' } }, [
              h('div', { style: { fontSize: '14px', fontWeight: '600', color: '#166534' } }, L.pairedStatus),
              h('div', { style: { fontSize: '12px', color: '#16a34a' } },
                `${L.deviceLabel}: ${tunnel.deviceName.value || 'Android Phone'}`),
            ]),
            h('button', {
              onClick: handleUnpair,
              style: { padding: '6px', borderRadius: '8px', border: 'none', cursor: 'pointer', backgroundColor: 'transparent', color: '#9ca3af' },
              title: L.unpairButton,
            }, '\u2715'),
          ]),
        );

        // Test SMS
        if (props.showTestSms) {
          const testChildren: any[] = [
            h('div', { style: { fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '12px' } }, L.testSmsTitle),
            h('div', { style: s.inputRow }, [
              h('input', {
                value: testPhone.value,
                onInput: (e: Event) => { testPhone.value = (e.target as HTMLInputElement).value; },
                placeholder: L.testPhonePlaceholder,
                style: s.input,
              }),
              h('input', {
                value: testMsg.value,
                onInput: (e: Event) => { testMsg.value = (e.target as HTMLInputElement).value; },
                placeholder: L.testMessagePlaceholder,
                style: s.input,
              }),
              h('button', {
                style: { ...s.button, opacity: sendingTest.value || !testPhone.value.trim() ? '0.5' : '1' },
                onClick: handleTestSms,
                disabled: sendingTest.value || !testPhone.value.trim(),
              }, sendingTest.value ? h('span', { style: s.spinner }) : L.sendTestButton),
            ]),
          ];

          if (testResult.value) {
            testChildren.push(
              h('div', { style: testResult.value.success ? s.success : s.errorSmall },
                testResult.value.success
                  ? `${L.smsSentSuccess} (ID: ${testResult.value.messageId})`
                  : `${L.smsError}: ${testResult.value.error}`),
            );
          }

          children.push(h('div', { style: s.section }, testChildren));
        }
      } else {
        // Unpaired banner
        children.push(
          h('div', { style: s.unpairedBanner }, [
            h('div', { style: { fontSize: '24px' } }, '\uD83D\uDCF1'),
            h('div', {}, [
              h('div', { style: { fontSize: '14px', fontWeight: '600', color: '#854d0e' } }, L.notPairedStatus),
              h('div', { style: { fontSize: '12px', color: '#a16207' } }, L.notPairedDescription),
            ]),
          ]),
        );

        if (!tunnel.showQr.value) {
          children.push(
            h('button', {
              style: { ...s.button, opacity: tunnel.generating.value ? '0.5' : '1' },
              onClick: tunnel.generateQr,
              disabled: tunnel.generating.value,
            }, [
              tunnel.generating.value ? h('span', { style: s.spinner }) : null,
              L.connectButton,
            ]),
          );
        } else {
          children.push(
            h('div', { style: s.qrContainer }, [
              h('div', { style: { fontSize: '13px', color: '#4b5563', marginBottom: '12px' } }, L.scanQrPrompt),
              h('div', { style: s.qrFrame }, [
                h(QrCodeCanvas, { value: tunnel.qrData.value, size: props.qrSize }),
              ]),
              h('div', {
                style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '12px', color: '#9ca3af', marginBottom: '12px' },
              }, [
                h('span', { style: s.spinner }),
                L.waitingForPairing,
              ]),
              h('button', { style: s.buttonSecondary, onClick: tunnel.cancelPairing }, L.cancelButton),
            ]),
          );
        }
      }

      return h('div', { style: s.container }, [
        h('div', { style: s.card }, children),
      ]);
    };
  },
});
