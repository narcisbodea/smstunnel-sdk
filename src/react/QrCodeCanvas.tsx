import { useEffect, useRef } from 'react';
import qrcode from 'qrcode-generator';

export interface QrCodeCanvasProps {
  value: string;
  size?: number;
}

export function QrCodeCanvas({ value, size = 200 }: QrCodeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !value) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const cellSize = size / moduleCount;

    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }
  }, [value, size]);

  return <canvas ref={canvasRef} width={size} height={size} />;
}
