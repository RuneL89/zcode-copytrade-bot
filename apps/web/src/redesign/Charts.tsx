/** Small SVG charts fed by server-provided series. No client-side money math. */

export function Sparkline({
  values,
  width = 84,
  height = 30,
  className = 'sspark',
}: {
  values: bigint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const points = values.length >= 2 ? values.map((v) => Number(v)) : [0, 0];
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const span = max - min || 1;
  const x = (i: number) => (i * width) / Math.max(1, points.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const rising = points[points.length - 1]! >= points[0]!;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
        stroke={rising ? '#34d399' : '#f87171'}
      />
    </svg>
  );
}

export function EquityChart({ values, height = 112 }: { values: string[]; height?: number }) {
  const points = values.map((value) => Number(BigInt(value))).filter((value) => Number.isFinite(value));
  if (points.length < 2) {
    return (
      <div className="dim" style={{ fontSize: 12, padding: '26px 0' }}>
        Equity history is not available yet — the series fills as the desk runs.
      </div>
    );
  }
  const width = 400;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (i: number) => (i * width) / Math.max(1, points.length - 1);
  const y = (v: number) => height - 4 - ((v - min) / span) * (height - 10);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const open = points[Math.max(0, points.length - 60)] ?? points[0]!;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="cdx-eq" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#7c6cff" stopOpacity=".35" />
          <stop offset="1" stopColor="#7c6cff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        x2={width}
        y1={y(open)}
        y2={y(open)}
        stroke="#2a2f3e"
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />
      <path d={`${d} L${width} ${height} L0 ${height}Z`} fill="url(#cdx-eq)" />
      <path d={d} fill="none" stroke="#a197ff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1]!)} r="3.5" fill="#a197ff" />
    </svg>
  );
}
