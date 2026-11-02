import { describe, expect, it } from 'vitest';
import {
  STAGE_ORDER,
  STAGE_H,
  STAGE_W,
  VIEW_H,
  VIEW_W,
  mainEdge,
  pctX,
  pctY,
  pipelineEdges,
  returnEdge,
  stageBoxes,
  strokeWidth,
} from '../src/components/pipeline/layout';

/**
 * Plan 07 layout math: deterministic node positions, monotonic edge thickness
 * (`1 + log(1 + count)` with a legibility floor), and full geometry even for
 * empty stages (zero counts still render the structure).
 */
describe('pipeline layout', () => {
  it('places the five stages deterministically, left to right, inside the viewBox', () => {
    const a = stageBoxes();
    const b = stageBoxes();
    expect(a).toEqual(b); // pure: same input, same boxes
    const xs = STAGE_ORDER.map((id) => a[id].x);
    expect(xs).toEqual([...xs].sort((m, n) => m - n));
    for (const id of STAGE_ORDER) {
      const box = a[id];
      expect(box.w).toBe(STAGE_W);
      expect(box.h).toBe(STAGE_H);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(VIEW_W);
      expect(box.y + box.h).toBeLessThanOrEqual(VIEW_H);
    }
    // Neighbours never overlap.
    for (let i = 1; i < STAGE_ORDER.length; i++) {
      expect(a[STAGE_ORDER[i]!].x).toBeGreaterThanOrEqual(a[STAGE_ORDER[i - 1]!].x + STAGE_W);
    }
  });

  it('thickness grows monotonically with the 24h count and never vanishes', () => {
    const widths = [0, 1, 2, 5, 20, 100, 1000].map(strokeWidth);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
    }
    expect(strokeWidth(0)).toBeGreaterThanOrEqual(1.5); // the legibility floor
    expect(strokeWidth(-3)).toBe(strokeWidth(0)); // negatives clamp to zero
  });

  it('renders empty stages: zero counts still produce all five edges', () => {
    const edges = pipelineEdges();
    expect(edges).toHaveLength(5);
    expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'discovery->pool',
      'pool->watch',
      'watch->roster',
      'roster->exits',
      'exits->watch',
    ]);
    for (const edge of edges) {
      expect(edge.path).toMatch(/^M [\d.]+ [\d.]+ C /);
      expect(edge.chevron).toMatch(/^M /);
    }
    // The return lane dips below the node row; forward edges stay level.
    const lane = returnEdge();
    expect(lane.lane).toBe(true);
    const laneNumbers = [...lane.path.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    const nodeBottom = stageBoxes().watch.y + STAGE_H;
    expect(Math.max(...laneNumbers)).toBeGreaterThan(nodeBottom);
    expect(mainEdge('pool', 'watch').lane).toBe(false);
  });

  it('percentage helpers map viewBox coordinates into the container exactly', () => {
    expect(pctX(0)).toBe('0%');
    expect(pctX(VIEW_W)).toBe('100%');
    expect(pctX(VIEW_W / 2)).toBe('50%');
    expect(pctY(0)).toBe('0%');
    expect(pctY(VIEW_H)).toBe('100%');
  });
});
