import type { SVGProps } from 'react';

const base = (d: string, fill = false) =>
  function Icon(props: SVGProps<SVGSVGElement> & { size?: number }) {
    const { size = 16, ...rest } = props;
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        <path d={d} />
      </svg>
    );
  };

export const IconPlay = base('M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z', true);
export const IconPause = base('M6 4h4v16H6zM14 4h4v16h-4z', true);
export const IconStop = base('M6 6h12v12H6z', true);
export const IconLoop = base('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3');
export const IconPlus = base('M12 5v14M5 12h14');
export const IconFolder = base('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
export const IconSplit = base('M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4');
export const IconTrash = base('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14');
export const IconExport = base('M12 3v12M7 10l5 5 5-5M4 19h16');
export const IconSave = base('M5 3h11l3 3v15H5zM8 3v6h8M8 21v-7h8v7');
export const IconUndo = base('M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3');
export const IconRedo = base('M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3');
export const IconMusic = base('M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z');
export const IconWave = base('M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h0');
export const IconSliders = base('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6');
export const IconDisc = base('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z');
export const IconGear = base(
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
);
export const IconMidi = base('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM7 12h.01M17 12h.01M9 8h.01M15 8h.01M12 7h.01M12 17v-3');
export const IconCloud = base('M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z');
export const IconRecord = base('M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', true);
export const IconSearch = base('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35');
export const IconX = base('M18 6L6 18M6 6l12 12');
export const IconCopy = base('M9 9h11v11H9zM5 15H4V4h11v1');
export const IconSync = base('M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5');
export const IconExternal = base('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3');
