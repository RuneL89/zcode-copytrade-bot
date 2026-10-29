/** Custom SVG chart primitives (no chart library). */

export function Sparkline({
  points,
  width = 340,
  height = 56,
  positive,
}: {
  points: number[];
  width?: number;
  height?: number;
  positive: boolean;
}) {
  if (points.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => [i * step, height - 4 - ((p - min) / span) * (height - 10)] as const);
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  const stroke = positive ? '#16a06a' : '#e85454';
  const id = `spark-${positive ? 'pos' : 'neg'}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="equity sparkline"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={coords[coords.length - 1]![0]} cy={coords[coords.length - 1]![1]} r="3" fill={stroke} />
    </svg>
  );
}

export function Lollipop({
  values,
  width = 340,
  height = 120,
}: {
  values: number[]; // micro-USD integers
  width?: number;
  height?: number;
}) {
  const nonEmpty = values.length > 0;
  const maxAbs = nonEmpty ? Math.max(...values.map((v) => Math.abs(v)), 1) : 1;
  const zeroY = height / 2;
  const barW = Math.max(3, Math.min(10, width / Math.max(values.length, 1) - 3));
  const gap = width / Math.max(values.length, 1);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="realized close PnL per copied trade, zero baseline visible"
    >
      <line
        x1="0"
        y1={zeroY}
        x2={width}
        y2={zeroY}
        stroke="rgba(42,39,64,0.28)"
        strokeWidth="1"
        strokeDasharray="3 4"
      />
      {values.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / maxAbs) * (height / 2 - 8));
        const x = i * gap + (gap - barW) / 2;
        const pos = v >= 0;
        return (
          <g key={i}>
            <rect
              x={x}
              y={pos ? zeroY - h : zeroY}
              width={barW}
              height={h}
              rx={Math.min(3, barW / 2)}
              fill={pos ? '#16a06a' : '#e85454'}
              opacity="0.92"
            />
            <circle
              cx={x + barW / 2}
              cy={pos ? zeroY - h : zeroY + h}
              r="1.8"
              fill={pos ? '#0d7a4e' : '#c03c3c'}
            />
          </g>
        );
      })}
      {!nonEmpty && (
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="10" fill="#7d78a0">
          no copied closes yet
        </text>
      )}
    </svg>
  );
}

/** Gradient circular avatar with initials fallback (accessible). */
export function Avatar({ name, url, size = 44 }: { name: string; url?: string | null; size?: number }) {
  const initials =
    name
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase() || '??';
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <div
      role="img"
      aria-label={`avatar for ${name}`}
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: url
          ? `center/cover url(${url})`
          : `linear-gradient(135deg, hsl(${hue} 80% 72%), hsl(${(hue + 60) % 360} 75% 62%))`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontWeight: 600,
        fontSize: size * 0.34,
        textShadow: '0 1px 2px rgba(0,0,0,0.25)',
        flexShrink: 0,
      }}
    >
      {!url && initials}
    </div>
  );
}
