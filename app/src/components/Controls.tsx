import { type ReactNode, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clamp } from '../music';
import { useApp } from '../store/app';

// ---- Knob ---------------------------------------------------------------------------

interface KnobProps {
  value: number;
  min: number;
  max: number;
  onChange(v: number): void;
  label?: string;
  size?: number;
  color?: string;
  defaultValue?: number;
  bipolar?: boolean;
  disabled?: boolean;
  format?: (v: number) => string;
  title?: string;
}

/** Drag up/down (Shift for fine), scroll wheel, double-click to reset. */
export function Knob({ value, min, max, onChange, label, size = 38, color = 'var(--accent)', defaultValue, bipolar, disabled, format, title }: KnobProps) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const [hover, setHover] = useState(false);
  const norm = (clamp(value, min, max) - min) / (max - min);
  const start = -135;
  const angle = start + norm * 270;
  const r = size / 2 - 4;
  const c = size / 2;
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1} ${y1}`;
  };
  const from = bipolar ? 0 : start;
  const reset = defaultValue ?? (bipolar ? (min + max) / 2 : min);

  return (
    <div
      className={`knob${disabled ? ' disabled' : ''}`}
      title={title ?? (format ? format(value) : undefined)}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as Element).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const range = e.shiftKey ? 600 : 160;
        onChange(clamp(drag.current.v + ((drag.current.y - e.clientY) / range) * (max - min), min, max));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => !disabled && onChange(reset)}
      onWheel={(e) => !disabled && onChange(clamp(value - Math.sign(e.deltaY) * (max - min) * 0.03, min, max))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.08)" />
        <path d={arc(start, start + 270)} stroke="rgba(255,255,255,0.09)" strokeWidth={3} fill="none" strokeLinecap="round" />
        {Math.abs(angle - from) > 0.5 && (
          <path
            d={arc(Math.min(from, angle), Math.max(from, angle))}
            stroke={color}
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 3px ${color})` }}
          />
        )}
        <line
          x1={c}
          y1={c}
          x2={c + (r - 5) * Math.sin((angle * Math.PI) / 180)}
          y2={c - (r - 5) * Math.cos((angle * Math.PI) / 180)}
          stroke="#e9edff"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      {label && <div className="knob-label">{hover && format ? format(value) : label}</div>}
    </div>
  );
}

// ---- Fader --------------------------------------------------------------------------

interface FaderProps {
  value: number;
  min?: number;
  max?: number;
  onChange(v: number): void;
  orientation?: 'vertical' | 'horizontal';
  length?: number;
  defaultValue?: number;
  centerDetent?: boolean;
  invert?: boolean;
  title?: string;
}

export function Fader({ value, min = 0, max = 1, onChange, orientation = 'vertical', length = 120, defaultValue, centerDetent, invert, title }: FaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const vertical = orientation === 'vertical';
  const capL = 14;
  const thick = 30;
  let norm = (clamp(value, min, max) - min) / (max - min);
  if (invert) norm = 1 - norm;
  const pos = vertical ? (1 - norm) * (length - capL) : norm * (length - capL);

  const set = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    let n = vertical ? 1 - (clientY - rect.top - capL / 2) / (length - capL) : (clientX - rect.left - capL / 2) / (length - capL);
    n = clamp(n, 0, 1);
    if (invert) n = 1 - n;
    if (centerDetent && Math.abs(n - 0.5) < 0.025) n = 0.5;
    onChange(min + n * (max - min));
  };

  return (
    <div
      ref={ref}
      className={`fader ${orientation}`}
      title={title}
      style={vertical ? { width: thick, height: length } : { width: length, height: thick }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        set(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => e.buttons & 1 && set(e.clientX, e.clientY)}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      onWheel={(e) => onChange(clamp(value - Math.sign(e.deltaY) * (max - min) * 0.02, min, max))}
    >
      <div
        className="fader-track"
        style={vertical ? { left: thick / 2 - 3, width: 6, top: 0, bottom: 0 } : { top: thick / 2 - 3, height: 6, left: 0, right: 0 }}
      />
      {centerDetent && (
        <div
          style={{
            position: 'absolute',
            background: 'rgba(255,255,255,0.25)',
            ...(vertical ? { left: 4, right: 4, top: length / 2 - 0.5, height: 1 } : { top: 4, bottom: 4, left: length / 2 - 0.5, width: 1 }),
          }}
        />
      )}
      <div className="fader-cap" style={vertical ? { left: 2, width: thick - 4, top: pos, height: capL } : { top: 2, height: thick - 4, left: pos, width: capL }} />
    </div>
  );
}

// ---- Modal & toasts -------------------------------------------------------------------

export function Modal({ title, children, onClose, width }: { title: string; children: ReactNode; onClose(): void; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="grow">{t.text}</div>
          {t.action && (
            <button
              className="btn sm"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="btn sm ghost icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- hooks ------------------------------------------------------------------------------

/** Re-render when an object with subscribe(fn) notifies (Deck). */
export function useSubscribe(obj: { subscribe(fn: () => void): () => void } | null) {
  const version = useRef(0);
  useSyncExternalStore(
    (cb) => (obj ? obj.subscribe(() => {
      version.current++;
      cb();
    }) : () => undefined),
    () => version.current,
  );
}

/** False inside a section that is mounted but hidden (so its animations can stop). */
export const ViewVisible = createContext(true);

/** requestAnimationFrame loop that runs while `active` and its section is on screen. */
export function useRaf(fn: () => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  const visible = useContext(ViewVisible);
  active = active && visible;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = () => {
      ref.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}

export function Camelot({ code, name }: { code: string; name?: string }) {
  if (!code) return <span className="faint">—</span>;
  const num = parseInt(code, 10);
  const minor = code.endsWith('A');
  const hue = ((num - 1) * 30 + 150) % 360;
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="cam" style={{ background: `hsl(${hue} ${minor ? 70 : 85}% ${minor ? 62 : 72}%)` }}>
        {code}
      </span>
      {name && <span className="muted">{name}</span>}
    </span>
  );
}

/** Canvas sized to its CSS box at device pixel ratio; draw(ctx, w, h) in CSS pixels. */
export function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(size.w * dpr) || el.height !== Math.round(size.h * dpr)) {
      el.width = Math.round(size.w * dpr);
      el.height = Math.round(size.h * dpr);
    }
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    draw(ctx, size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ...deps]);
  return ref;
}
