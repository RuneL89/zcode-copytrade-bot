/**
 * Pipeline layout math (plan 07) — pure functions, unit-tested. The desktop
 * spine is one SVG coordinate space (VIEW_W × VIEW_H); the DOM stage buttons
 * reuse the same boxes through percentage helpers, so the SVG edges and the
 * real, focusable buttons can never drift apart.
 */

export type StageId = 'discovery' | 'pool' | 'watch' | 'roster' | 'exits';

export interface StageBox {
  id: StageId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeGeometry {
  from: StageId;
  to: StageId;
  path: string;
  /** Arrowless (Sankey convention): a small direction chevron near the target. */
  chevron: string;
  /** Dip below the nodes for the Fired → Watch return lane. */
  lane: boolean;
}

export const VIEW_W = 1016;
export const VIEW_H = 212;
export const STAGE_W = 176;
export const STAGE_H = 88;
export const STAGE_Y = 6;

export const STAGE_ORDER: StageId[] = ['discovery', 'pool', 'watch', 'roster', 'exits'];

const GAP = (VIEW_W - STAGE_ORDER.length * STAGE_W) / (STAGE_ORDER.length - 1);

/** The five stage boxes, left to right. Deterministic, no DOM access. */
export function stageBoxes(): Record<StageId, StageBox> {
  const out = {} as Record<StageId, StageBox>;
  STAGE_ORDER.forEach((id, i) => {
    out[id] = { id, x: i * (STAGE_W + GAP), y: STAGE_Y, w: STAGE_W, h: STAGE_H };
  });
  return out;
}

/** Left→right edge between neighbouring stages (straight Sankey flow). */
export function mainEdge(from: StageId, to: StageId): EdgeGeometry {
  const boxes = stageBoxes();
  const a = boxes[from];
  const b = boxes[to];
  const y = a.y + a.h / 2;
  const x1 = a.x + a.w;
  const x2 = b.x;
  return {
    from,
    to,
    path: `M ${x1} ${y} C ${x1 + 16} ${y}, ${x2 - 16} ${y}, ${x2} ${y}`,
    chevron: chevronAt(x2, y, 'right'),
    lane: false,
  };
}

/**
 * The replacement lane: Exits → Watch, dipping below the nodes so the return
 * flow reads without crossing the forward edges.
 */
export function returnEdge(from: StageId = 'exits', to: StageId = 'watch'): EdgeGeometry {
  const boxes = stageBoxes();
  const a = boxes[from];
  const b = boxes[to];
  const sx = a.x + a.w / 2;
  const tx = b.x + b.w / 2;
  const sy = a.y + a.h;
  const ty = b.y + b.h;
  const dip = sy + 56;
  return {
    from,
    to,
    path: `M ${sx} ${sy} C ${sx} ${dip}, ${tx} ${dip}, ${tx} ${ty}`,
    chevron: chevronAt(tx, ty + 12, 'up'),
    lane: true,
  };
}

/**
 * Edge thickness encodes the 24h volume: `1 + log(1 + count)` (plan 07), with a
 * 1.5px legibility floor so a zero-volume edge stays visible as structure.
 */
export function strokeWidth(count24h: number): number {
  const n = Math.max(0, count24h);
  return Math.max(1.5, 1 + Math.log(1 + n));
}

/** All five edges of the spine. */
export function pipelineEdges(): EdgeGeometry[] {
  return [
    mainEdge('discovery', 'pool'),
    mainEdge('pool', 'watch'),
    mainEdge('watch', 'roster'),
    mainEdge('roster', 'exits'),
    returnEdge('exits', 'watch'),
  ];
}

/** Percentage position of a viewBox x/y inside the container (DOM nodes). */
export function pctX(x: number, viewW = VIEW_W): string {
  return `${(x / viewW) * 100}%`;
}
export function pctY(y: number, viewH = VIEW_H): string {
  return `${(y / viewH) * 100}%`;
}

function chevronAt(x: number, y: number, dir: 'right' | 'up'): string {
  if (dir === 'right') return `M ${x - 9} ${y - 4.5} L ${x - 2.5} ${y} L ${x - 9} ${y + 4.5}`;
  return `M ${x - 4.5} ${y + 6.5} L ${x} ${y} L ${x + 4.5} ${y + 6.5}`;
}
