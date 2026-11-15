import { useMemo } from 'react';
import type { DashboardState } from '../types';
import type { DropRow } from './model';
import { funnelModel } from './model';
import { avatarColor, avatarLetter, eetShort, humanReason } from './format';
import { useElementWidth, useMediaQuery } from './useRemote';

interface Stage {
  id: string;
  name: string;
  owner: string;
  count: number;
  today: number | null;
  description: string;
  retired: boolean;
}

interface Dot {
  key: string;
  handle: string | null;
  candidateId: string | null;
  color: string;
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  lx: number;
  ly: number;
}

const WEIGHTS = [1.4, 1, 1, 1, 1.05];
const DOT_SIZE = [9, 12, 15, 20, 26];
const MIN_H = [84, 56, 50, 46, 54];
const HORIZONTAL_HEIGHT = 392;

function pathFor(
  segs: Array<{ a0: number; a1: number; half: number }>,
  horizontal: boolean,
  c: number,
): string {
  const P = (a: number, b: number) =>
    horizontal ? `${a.toFixed(1)} ${b.toFixed(1)}` : `${b.toFixed(1)} ${a.toFixed(1)}`;
  const n = segs.length;
  const A = segs.map((s, i) => {
    const k = Math.min(16, (s.a1 - s.a0) / 4);
    return { a0: s.a0 + (i > 0 ? k : 0), a1: s.a1 - (i < n - 1 ? k : 0), half: s.half };
  });
  let d = 'M' + P(A[0]!.a0, c - A[0]!.half);
  A.forEach((s, i) => {
    if (i > 0) {
      const p = A[i - 1]!;
      const m = (p.a1 + s.a0) / 2;
      d += ` C${P(m, c - p.half)} ${P(m, c - s.half)} ${P(s.a0, c - s.half)}`;
    }
    d += ` L${P(s.a1, c - s.half)}`;
  });
  d += ` L${P(A[n - 1]!.a1, c + A[n - 1]!.half)}`;
  for (let i = n - 1; i >= 0; i--) {
    const s = A[i]!;
    d += ` L${P(s.a0, c + s.half)}`;
    if (i > 0) {
      const p = A[i - 1]!;
      const m = (p.a1 + s.a0) / 2;
      d += ` C${P(m, c + s.half)} ${P(m, c + p.half)} ${P(p.a1, c + p.half)}`;
    }
  }
  return d + ' Z';
}

function rowsNeeded(n: number, width: number, dot: number): number {
  const per = Math.max(1, Math.floor(width / (dot + 5)));
  return Math.ceil(n / per) * (dot + 5) + 18;
}

function stageDots(stage: Stage, state: DashboardState): Dot[] {
  if (stage.id === 'shadow') {
    return state.watchlist.rows
      .filter((row) => row.status === 'watching')
      .slice(0, 42)
      .map((row) => ({
        key: row.candidateId,
        handle: row.handle,
        candidateId: row.candidateId,
        color: avatarColor(row.handle),
      }));
  }
  if (stage.id === 'bench') {
    return state.watchlist.rows
      .filter((row) => row.status === 'bench')
      .slice(0, 42)
      .map((row) => ({
        key: row.candidateId,
        handle: row.handle,
        candidateId: row.candidateId,
        color: avatarColor(row.handle),
      }));
  }
  if (stage.id === 'review') return [];
  const shown = Math.min(stage.count, 42);
  return Array.from({ length: shown }, (_, i) => ({
    key: `${stage.id}-${i}`,
    handle: null,
    candidateId: null,
    color: avatarColor(`${stage.id}-${i}`),
  }));
}

/** The organic funnel shape from the approved mockup, fed by real counts. */
export function Funnel({
  state,
  drops,
  onSelectWatch,
}: {
  state: DashboardState;
  drops: DropRow[];
  onSelectWatch: (candidateId: string) => void;
}) {
  const model = funnelModel(state);
  const mobile = useMediaQuery('(max-width:760px)');
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const stages = model.stages as Stage[];

  const layout = useMemo(() => {
    if (width < 80) return null;
    const lists = stages.map((stage) => stageDots(stage, state));
    const counts = stages.map((stage) => stage.count);
    const mx = Math.max(...counts, 1);
    const segs: Array<{ a0: number; a1: number; half: number }> = [];
    const rects: Rect[] = [];
    let height = HORIZONTAL_HEIGHT;
    let cy = 0;
    let convY = 0;
    let mouthX = 0;

    if (!mobile) {
      const top = 56;
      const bandMax = HORIZONTAL_HEIGHT - top - 118;
      cy = top + bandMax / 2;
      const units = WEIGHTS.reduce((a, b) => a + b, 0);
      const mouth = 40;
      const cw = (width - 4 - mouth) / units;
      let x = 4;
      stages.forEach((stage, i) => {
        const w = WEIGHTS[i]! * cw;
        let h = Math.max(
          DOT_SIZE[i]! + 26,
          (bandMax * counts[i]!) / mx,
          rowsNeeded(lists[i]!.length, w - 26, DOT_SIZE[i]!),
        );
        h = Math.min(h, bandMax);
        segs.push({ a0: x, a1: x + w, half: h / 2 });
        rects.push({
          x0: x + 14,
          x1: x + w - 14,
          y0: cy - h / 2 + 9,
          y1: cy + h / 2 - 9,
          cx: x + w / 2,
          cy,
          w,
          h,
          lx: x,
          ly: 0,
        });
        x += w;
      });
      segs.push({ a0: x, a1: width + 2, half: 13 });
      convY = top + bandMax + 8;
      mouthX = x;
    } else {
      let y = 54;
      const maxW = width - 12;
      stages.forEach((stage, i) => {
        let w = Math.max(DOT_SIZE[i]! * 4 + 40, (maxW * counts[i]!) / mx);
        w = Math.min(w, maxW);
        const h = Math.max(MIN_H[i]!, rowsNeeded(lists[i]!.length, w - 28, DOT_SIZE[i]!));
        segs.push({ a0: y, a1: y + h, half: w / 2 });
        rects.push({
          x0: width / 2 - w / 2 + 14,
          x1: width / 2 + w / 2 - 14,
          y0: y + 8,
          y1: y + h - 8,
          cx: width / 2,
          cy: y + h / 2,
          w,
          h,
          lx: 0,
          ly: y - 34,
        });
        y += h + 40;
      });
      segs.push({ a0: y - 22, a1: y + 12, half: 14 });
      height = y + 14;
    }

    const dots = lists.map((list, i) => {
      const rect = rects[i]!;
      const n = list.length;
      if (!n) return [];
      const d = DOT_SIZE[i]!;
      const aw = Math.max(1, rect.x1 - rect.x0);
      const ah = Math.max(1, rect.y1 - rect.y0);
      const per = Math.max(1, Math.min(n, Math.floor(aw / (d + 5))));
      const rows = Math.ceil(n / per);
      const sx = Math.min(d + 5, aw / per);
      const sy = Math.min((d + 5) * 1.05, ah / rows);
      return list.map((dot, j) => {
        const row = Math.floor(j / per);
        const col = j % per;
        const k = row === rows - 1 ? n - row * per : per;
        const x = rect.cx + (col - (k - 1) / 2) * sx;
        const y = rect.cy + (row - (rows - 1) / 2) * sy;
        return { ...dot, x, y, size: d, stage: i };
      });
    });

    return {
      lists,
      counts,
      rects,
      segs,
      dots,
      height,
      cy,
      convY,
      mouthX,
      path: pathFor(segs, !mobile, mobile ? width / 2 : cy),
      flow: mobile
        ? `M${width / 2} ${rects[4]?.cy ?? 0} L${width / 2} ${height}`
        : `M${rects[4]?.cx ?? 0} ${cy} L${width} ${cy}`,
    };
  }, [countsKey(stages), mobile, state, width]);

  const dropped = drops.length;
  return (
    <div className="funnel-block">
      <div
        ref={ref}
        className={`funnel ${mobile ? 'vert' : ''}`}
        style={mobile && layout ? { height: layout.height } : undefined}
      >
        {layout && (
          <>
            <svg id="fsvg" preserveAspectRatio="none" viewBox={`0 0 ${width} ${layout.height}`}>
              <defs>
                <linearGradient id="fg" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#60a5fa" stopOpacity=".10" />
                  <stop offset=".75" stopColor="#7c6cff" stopOpacity=".22" />
                  <stop offset="1" stopColor="#34d399" stopOpacity=".35" />
                </linearGradient>
                <linearGradient id="fgv" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#60a5fa" stopOpacity=".10" />
                  <stop offset=".75" stopColor="#7c6cff" stopOpacity=".22" />
                  <stop offset="1" stopColor="#34d399" stopOpacity=".35" />
                </linearGradient>
              </defs>
              <path id="fpath" d={layout.path} />
              <path id="fflow" d={layout.flow} />
            </svg>
            <div id="flabels">
              {stages.map((stage, i) => {
                const rect = layout.rects[i]!;
                const prev = i > 0 ? countsSafe(layout.counts[i - 1]) : 0;
                const conversion = i > 0 && prev > 0 ? Math.round((100 * stage.count) / prev) : null;
                if (!mobile) {
                  return (
                    <div
                      key={stage.id}
                      className="flab"
                      data-testid={`funnel-stage-${stage.id}`}
                      style={{ left: rect.lx, width: rect.w, top: 0 }}
                    >
                      <div className="nm">
                        <span className="ix">{String(i + 1).padStart(2, '0')}</span>
                        {stage.name}
                        <i className={`owner ${stage.owner}`}>{stage.retired ? 'D6' : stage.owner}</i>
                      </div>
                      <div className="ct num">
                        {stage.count}
                        {stage.retired && <small>retired</small>}
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={stage.id}
                    className="flab"
                    data-testid={`funnel-stage-${stage.id}`}
                    style={{
                      left: 0,
                      right: 0,
                      top: rect.ly,
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                    }}
                  >
                    <div className="nm">
                      <span className="ix">{String(i + 1).padStart(2, '0')}</span>
                      {stage.name}
                      <i className={`owner ${stage.owner}`}>{stage.retired ? 'D6' : stage.owner}</i>
                    </div>
                    <div className="ct num" style={{ fontSize: 16, margin: 0 }}>
                      {stage.count}
                      {stage.retired && <small style={{ fontSize: 10 }}> retired</small>}
                    </div>
                    <span
                      className="cvp num"
                      style={{ position: 'static', transform: 'none', marginLeft: 'auto' }}
                    >
                      {conversion === null ? '' : `↓ ${conversion}%`}
                    </span>
                    <span className="dropn num" style={{ position: 'static', transform: 'none' }}>
                      {stage.count === 0
                        ? '−0'
                        : `−${Math.max(0, (layout.counts[i - 1] ?? 0) - stage.count)}`}
                    </span>
                  </div>
                );
              })}
              {!mobile &&
                layout.rects.map((rect, i) => {
                  if (i === 0) return null;
                  const prev = countsSafe(layout.counts[i - 1]);
                  const conversion = prev > 0 ? Math.round((100 * (layout.counts[i] ?? 0)) / prev) : null;
                  return (
                    <div key={`conv-${i}`} className="cvp num" style={{ left: rect.lx, top: layout.convY }}>
                      {conversion === null ? '—' : `${conversion}% →`}
                    </div>
                  );
                })}
              {!mobile && (
                <>
                  <div
                    className="cvp num"
                    style={{
                      left: layout.mouthX + 4,
                      top: layout.convY,
                      color: '#86efac',
                      borderColor: 'rgba(52,211,153,.4)',
                    }}
                  >
                    {model.hired} hired
                  </div>
                  <div className="mouthlbl" style={{ right: 2, top: layout.cy - 30 }}>
                    SEATS ▸
                  </div>
                  <div className="gutline" style={{ top: layout.height - 44 }} />
                  <div className="gutlbl" style={{ top: layout.height - 40 }}>
                    Dropouts ↓
                  </div>
                </>
              )}
              {mobile && (
                <div className="mouthlbl" style={{ left: '50%', transform: 'translateX(-50%)', bottom: -2 }}>
                  ▼ {model.hired} HIRED · SEATS
                </div>
              )}
            </div>
            <div id="fdots">
              {layout.dots.flat().map((dot) => (
                <div
                  key={dot.key}
                  data-testid={dot.candidateId ? `funnel-dot-${dot.candidateId}` : undefined}
                  className={`fdot s${dot.stage} ${dot.handle ? '' : 'generic'}`}
                  title={
                    dot.handle
                      ? `${dot.handle} — click for the shadow record`
                      : 'counted trader (identity not in this payload)'
                  }
                  style={{
                    width: dot.size,
                    height: dot.size,
                    background: dot.color,
                    transform: `translate(${(dot.x - dot.size / 2).toFixed(1)}px, ${(dot.y - dot.size / 2).toFixed(1)}px)`,
                    cursor: dot.candidateId ? 'pointer' : 'default',
                  }}
                  onClick={() => dot.candidateId && onSelectWatch(dot.candidateId)}
                >
                  {dot.handle && dot.size >= 15 ? avatarLetter(dot.handle) : ''}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="dropouts">
        <span className="lb">Dropouts</span>
        {drops.slice(0, 4).map((drop) => (
          <span key={drop.id} className="dchip" title={drop.detail ?? undefined}>
            <b>{drop.handle ?? '—'}</b> · {humanReason(drop.reason)} <i>{eetShort(drop.at)}</i>
          </span>
        ))}
        {dropped === 0 && (
          <span className="dim" style={{ fontSize: 11.5 }}>
            No rejections recorded yet.
          </span>
        )}
      </div>
    </div>
  );
}

function countsSafe(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The memo key only needs the counts; state identity changes on every SSE tick. */
function countsKey(stages: Stage[]): string {
  return stages.map((stage) => stage.count).join(',');
}
