/** Custom SVG chart primitives for the equity sparkline + avatars.
 *  The closes chart uses recharts (see ClosesChart.tsx). */

export function Sparkline({
  points,
  width = 340,
  height = 56,
  positive,
  responsive = false,
}: {
  points: number[];
  width?: number;
  height?: number;
  positive: boolean;
  responsive?: boolean;
}) {
  if (points.length < 2) {
    return <svg width={responsive ? '100%' : width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => [i * step, height - 4 - ((p - min) / span) * (height - 10)] as const);
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  const stroke = positive ? 'var(--color-pos)' : 'var(--color-neg)';
  const id = `spark-${positive ? 'pos' : 'neg'}`;
  return (
    <svg
      width={responsive ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={responsive ? 'none' : undefined}
      role="img"
      aria-label="equity sparkline"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
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
        vectorEffect={responsive ? 'non-scaling-stroke' : undefined}
      />
      {responsive ? null : (
        <circle cx={coords[coords.length - 1]![0]} cy={coords[coords.length - 1]![1]} r="3" fill={stroke} />
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
          : `linear-gradient(135deg, hsl(${hue} 70% 42%), hsl(${(hue + 60) % 360} 65% 32%))`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontWeight: 600,
        fontSize: size * 0.34,
        textShadow: '0 1px 2px rgba(0,0,0,0.4)',
        flexShrink: 0,
      }}
    >
      {!url && initials}
    </div>
  );
}
