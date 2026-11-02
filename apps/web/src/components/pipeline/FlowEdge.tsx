import { strokeWidth, type EdgeGeometry } from './layout';

/**
 * One spine edge: an arrowless Bézier whose thickness encodes the 24h count,
 * with a small direction chevron near the target. The whole SVG is
 * `aria-hidden` in PipelineFlow — the accessible structure is the stage list.
 */
export function FlowEdge({
  edge,
  count24h,
  active,
}: {
  edge: EdgeGeometry;
  count24h: number;
  active: boolean;
}) {
  const width = strokeWidth(count24h);
  return (
    <g data-edge={`${edge.from}-${edge.to}`}>
      <path d={edge.path} className="flow-edge" strokeWidth={width} />
      {count24h > 0 && (
        <path d={edge.chevron} className="flow-edge" strokeWidth={1.5} opacity={0.9} data-edge-chevron />
      )}
      {(active || count24h > 0) && (
        <path
          d={edge.path}
          className={`flow-edge ${active ? 'flow-edge--active' : 'flow-edge--idle'}`}
          strokeWidth={width}
          strokeDasharray="3 9"
        />
      )}
    </g>
  );
}
