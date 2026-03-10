import { defineComponent, ref, onMounted, watch, h } from 'vue';
import qrcode from 'qrcode-generator';

export const QrCodeCanvas = defineComponent({
  name: 'QrCodeCanvas',
  props: {
    value: { type: String, required: true },
    size: { type: Number, default: 200 },
  },
  setup(props) {
    const canvasRef = ref<HTMLCanvasElement | null>(null);

    function render() {
      if (!canvasRef.value || !props.value) return;
      const canvas = canvasRef.value;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const qr = qrcode(0, 'M');
      qr.addData(props.value);
      qr.make();

      const moduleCount = qr.getModuleCount();
      const cellSize = props.size / moduleCount;

      canvas.width = props.size;
      canvas.height = props.size;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, props.size, props.size);
      ctx.fillStyle = '#000000';

      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
          }
        }
      }
    }

    onMounted(render);
    watch(() => [props.value, props.size], render);

    return () =>
      h('canvas', {
        ref: canvasRef,
        width: props.size,
        height: props.size,
      });
  },
});
