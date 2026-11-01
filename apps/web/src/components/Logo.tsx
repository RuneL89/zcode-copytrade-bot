/** ZCode Bot mark: charcoal tile + cyan robot head, matches public/favicon.svg. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="logo-head" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dedfb" />
          <stop offset="1" stopColor="#0ea5c4" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#0e1116" />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="14.25"
        stroke="#22d3ee"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <path d="M32 15v5" stroke="#22d3ee" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="32" cy="13.5" r="3.2" fill="#7dedfb" />
      <rect x="13" y="22" width="38" height="27" rx="9" fill="url(#logo-head)" />
      <circle cx="24.5" cy="34.5" r="3.6" fill="#0a0b0e" />
      <circle cx="39.5" cy="34.5" r="3.6" fill="#0a0b0e" />
      <path d="M26.5 42.5h11" stroke="#0a0b0e" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}
