/**
 * Copydesk mark: charcoal tile + cyan robot head, matches public/favicon.svg.
 * All five colors are brand tokens (`--color-brand-*`, defined once in
 * index.css) so the mark keeps its identity in both themes and this component
 * hardcodes no hex.
 */
const light = 'var(--color-brand-light)';
const mid = 'var(--color-brand-mid)';
const cyan = 'var(--color-brand-cyan)';
const tile = 'var(--color-brand-tile)';
const dark = 'var(--color-brand-dark)';

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="logo-head" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: light }} />
          <stop offset="1" style={{ stopColor: mid }} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" style={{ fill: tile }} />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="14.25"
        stroke={cyan}
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <path d="M32 15v5" stroke={cyan} strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="32" cy="13.5" r="3.2" style={{ fill: light }} />
      <rect x="13" y="22" width="38" height="27" rx="9" fill="url(#logo-head)" />
      <circle cx="24.5" cy="34.5" r="3.6" style={{ fill: dark }} />
      <circle cx="39.5" cy="34.5" r="3.6" style={{ fill: dark }} />
      <path d="M26.5 42.5h11" stroke={dark} strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}
