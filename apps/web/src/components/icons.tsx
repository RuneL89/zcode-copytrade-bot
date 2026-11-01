/** Minimal 18px stroke icon set for the tab bar and inline actions. */
interface IconProps {
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function PulseIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 12h4l2.5-7 4 14 2.5-7h5" />
    </svg>
  );
}

export function TerminalIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 17h7" />
    </svg>
  );
}

export function SlidersIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 8h9M17 8h3" />
      <circle cx="15" cy="8" r="2" />
      <path d="M4 16h3M11 16h9" />
      <circle cx="9" cy="16" r="2" />
    </svg>
  );
}

export function ListIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="2.4" />
    </svg>
  );
}

export function ClockIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}
