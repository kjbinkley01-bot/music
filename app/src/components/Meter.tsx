import { useRef } from 'react';
import { useRaf } from './Controls';

const buf = new Float32Array(1024);

/** Vertical peak meter with fall-off, fed by an AnalyserNode. Red above -1 dBFS. */
export function Meter({ analyser, height = 110, width = 6 }: { analyser: AnalyserNode; height?: number; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const level = useRef(0);
  useRaf(() => {
    const el = ref.current;
    if (!el) return;
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > peak) peak = v;
    }
    level.current = Math.max(peak, level.current * 0.92);
    // map -48..0 dBFS onto the bar
    const db = 20 * Math.log10(level.current + 1e-6);
    const frac = Math.max(0, Math.min(1, (db + 48) / 48));
    el.style.transform = `scaleY(${frac})`;
    el.style.background = db > -1 ? 'var(--bad)' : db > -6 ? 'var(--warn)' : 'var(--ok)';
  });
  return (
    <div style={{ width, height, borderRadius: 3, background: 'rgba(0,0,0,0.45)', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }} title="Level (red = clipping)">
      <div ref={ref} style={{ width: '100%', height: '100%', transformOrigin: 'bottom', transform: 'scaleY(0)', boxShadow: '0 0 6px currentColor' }} />
    </div>
  );
}
