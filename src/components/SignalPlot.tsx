import { useEffect, useRef } from 'react';
import { Box } from '@mantine/core';
import type { ReceptionResult } from '../receiver/receiver.js';

export function SignalPlot({
  result,
  spectrum = false,
}: {
  result: ReceptionResult | null;
  spectrum?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect(),
        dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const w = rect.width,
        h = rect.height;
      const theme = getComputedStyle(document.documentElement);
      const color = (name: string) => theme.getPropertyValue(name).trim();
      ctx.fillStyle = color('--mantine-color-dark-8');
      ctx.fillRect(0, 0, w, h);
      const left = spectrum ? 36 : 16,
        right = w - 16,
        top = 16,
        bottom = h - 26;
      ctx.strokeStyle = color('--mantine-color-default-border');
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = left + ((right - left) * i) / 4,
          y = top + ((bottom - top) * i) / 4;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
      ctx.font = '10px monospace';
      ctx.fillStyle = color('--mantine-color-dimmed');
      if (spectrum) {
        for (let i = 0; i <= 4; i++)
          ctx.fillText(String(-40 - i * 20), 4, top + ((bottom - top) * i) / 4 + 3);
        ctx.fillText('Offset (kHz)', Math.max(left, w / 2 - 35), h - 6);
        const data = result?.spectrum;
        if (!data?.x.length) return;
        const min = data.x[0],
          max = data.x[data.x.length - 1];
        ctx.strokeStyle = color('--mantine-color-white');
        ctx.beginPath();
        for (let i = 0; i < data.x.length; i++) {
          const x = left + ((data.x[i] - min) / (max - min)) * (right - left);
          const y = Math.max(
            top,
            Math.min(bottom, top + ((-40 - data.y[i]) / 80) * (bottom - top)),
          );
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillText(Math.round(min).toString(), left, h - 6);
        ctx.fillText(Math.round(max).toString(), right - 28, h - 6);
      } else {
        const scale = Math.min(right - left, bottom - top) / 4;
        const cx = (left + right) / 2,
          cy = (top + bottom) / 2;
        ctx.fillText('I', right - 8, cy - 6);
        ctx.fillText('Q', cx + 6, top + 10);
        ctx.fillText('Equalized · QPSK', 16, h - 7);
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        ctx.fillStyle = color('--mantine-color-white');
        ctx.globalAlpha = 0.5;
        const points = result?.points;
        if (points)
          for (let i = 0; i < points.length; i += 2)
            ctx.fillRect(cx + points[i] * scale, cy - points[i + 1] * scale, 1.5, 1.5);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [result, spectrum]);
  /* oxlint-disable jsx-a11y/prefer-tag-over-role -- A dynamically drawn canvas needs an accessible image role. */
  return (
    <Box
      component="canvas"
      ref={ref}
      role="img"
      aria-label={spectrum ? 'Received power spectrum' : 'Equalized QPSK constellation'}
      w="100%"
      style={{ display: 'block', aspectRatio: '1 / 1' }}
    />
  );
  /* oxlint-enable jsx-a11y/prefer-tag-over-role */
}
