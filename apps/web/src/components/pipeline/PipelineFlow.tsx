import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardState } from '../../types';
import { timeAgo } from '../../types';
import {
  STAGE_ORDER,
  VIEW_H,
  VIEW_W,
  pctX,
  pctY,
  pipelineEdges,
  stageBoxes,
  type EdgeGeometry,
  type StageId,
} from './layout';
import { StageNode, type StageView } from './StageNode';
import { FlowEdge } from './FlowEdge';
import { CandidateChip } from './CandidateChip';

/** Cap on chips travelling at once; further transitions only update counts. */
const MAX_CONCURRENT_CHIPS = 3;

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * The pipeline spine (plan 07): five stages — Discovery, Pool, Watch, Roster,
 * Exits — with the four forward edges plus the Fired → Watch return lane. Every
 * number is read from `DashboardState.pipeline` and rendered verbatim; this
 * component never derives a count. A transition (a count that grew since the
 * previous frame) spawns exactly one chip on that edge and pulses the target
 * node — capped at three concurrent chips, and suppressed entirely under
 * `prefers-reduced-motion` (the counts still update; only movement stops).
 */
export function PipelineFlow({ state }: { state: DashboardState }) {
  const p = state.pipeline;
  const desktop = useMedia('(min-width: 900px)');
  const motionOk = useMedia('(prefers-reduced-motion: no-preference)');
  const [selected, setSelected] = useState<StageId | null>(null);
  const [active, setActive] = useState<StageId | null>(null);
  const [chips, setChips] = useState<Array<{ id: number; edge: EdgeGeometry }>>([]);
  const chipId = useRef(0);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previous = useRef<Record<string, number> | null>(null);
  const [, forceTick] = useState(0);
  const now = Date.now();

  // Keep the "age" labels moving without refetching anything.
  useEffect(() => {
    const t = setInterval(() => forceTick((v) => v + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const edges = useMemo(() => pipelineEdges(), []);
  const edgeCount = (from: StageId, to: StageId): number =>
    p.edges.find((e) => e.from === from && e.to === to)?.count24h ?? 0;

  const seats = p.roster.length;
  // The chair count is server-set (ROSTER_SIZE); a payload without it shows no
  // fixed denominator rather than an invented one.
  const rosterSize = state.counters.rosterSize ?? seats;
  const stages: StageView[] = [
    {
      id: 'discovery',
      label: 'Discovery',
      value: p.discovery.newHandles24h,
      unit: 'new handles / 24h',
      hint: [
        p.discovery.sources.length ? p.discovery.sources.join(' · ') : 'no run yet',
        p.discovery.creditsRemaining === null
          ? 'credits —'
          : `${p.discovery.creditsRemaining.toLocaleString('en-US')} credits left`,
        `synced ${p.discovery.lastSyncAt ? timeAgo(p.discovery.lastSyncAt, now) : 'never'}`,
      ].join(' · '),
      aria: `Discovery: ${p.discovery.newHandles24h} new handles in 24 hours`,
    },
    {
      id: 'pool',
      label: 'Pool',
      value: p.pool.total,
      unit: 'candidates',
      hint: `${p.pool.withWallet} with wallet · ${p.pool.fundedBuyers24h} funded buyers / 24h`,
      aria: `Pool: ${p.pool.total} candidates, ${p.pool.fundedBuyers24h} funded buyers in 24 hours`,
    },
    {
      id: 'watch',
      label: 'Watch',
      value: p.watch.watching,
      unit: 'watching',
      hint: `${p.watch.promotable} promotable · bench target ${p.watch.benchTarget} · ${p.watch.cooling} cooling`,
      aria: `Watch: ${p.watch.watching} watching, ${p.watch.promotable} promotable of a bench target of ${p.watch.benchTarget}`,
    },
    {
      id: 'roster',
      label: 'Roster',
      value: seats,
      unit: `/ ${rosterSize} seats`,
      hint: `${seats} of ${rosterSize} chairs filled`,
      aria: `Roster: ${seats} of ${rosterSize} chairs filled`,
    },
    {
      id: 'exits',
      label: 'Exits',
      value: p.exits.fired24h,
      unit: 'fired / 24h',
      hint: `${p.exits.replacements24h} replacement(s) / 24h`,
      aria: `Exits: ${p.exits.fired24h} fired in 24 hours, ${p.exits.replacements24h} replaced`,
    },
  ];
  const stage = (id: StageId): StageView => stages.find((s) => s.id === id)!;

  // ---- transition chips + node pulse (one chip per grown edge, max 3) ------
  useEffect(() => {
    const counts: Record<string, number> = {
      discovery: stage('discovery').value,
      pool: stage('pool').value,
      watch: stage('watch').value,
      roster: stage('roster').value,
      exits: stage('exits').value,
      'discovery-pool': edgeCount('discovery', 'pool'),
      'pool-watch': edgeCount('pool', 'watch'),
      'watch-roster': edgeCount('watch', 'roster'),
      'roster-exits': edgeCount('roster', 'exits'),
      'exits-watch': edgeCount('exits', 'watch'),
    };
    const before = previous.current;
    previous.current = counts;
    if (!before || !motionOk) return;
    const grown = edges.filter(
      (e) => (counts[`${e.from}-${e.to}`] ?? 0) > (before[`${e.from}-${e.to}`] ?? 0),
    );
    if (grown.length === 0) return;
    setActive(grown[0]!.to);
    // One chip per grown edge (each removed by its own timer); at most three
    // are rendered at once.
    for (const edge of grown) {
      const id = chipId.current++;
      setChips((current) => [...current, { id, edge }]);
      setTimeout(() => setChips((current) => current.filter((c) => c.id !== id)), 1_450);
    }
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setActive(null), 1_500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.generatedAt, motionOk]);

  const selectedStage = selected ? stage(selected) : null;
  const boxes = stageBoxes();

  return (
    <section className="card p-4 mb-3.5" aria-label="pipeline" data-testid="pipeline-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Pipeline</p>
        <p className="label !text-[10px] !text-faint" data-testid="pipeline-asof">
          counts as of {timeAgo(p.asOf, now)} · server payload
        </p>
      </div>

      <nav aria-label="Trading pipeline" className="mt-2">
        {desktop ? (
          <div className="relative" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full"
              aria-hidden="true"
            >
              {edges.map((edge) => (
                <FlowEdge
                  key={`${edge.from}-${edge.to}`}
                  edge={edge}
                  count24h={edgeCount(edge.from, edge.to)}
                  active={active === edge.to}
                />
              ))}
              {chips.slice(-MAX_CONCURRENT_CHIPS).map((chip) => (
                <CandidateChip key={chip.id} id={chip.id} edge={chip.edge} />
              ))}
            </svg>
            <ol className="absolute inset-0 list-none m-0 p-0">
              {STAGE_ORDER.map((id) => {
                const box = boxes[id];
                return (
                  <li
                    key={id}
                    className="absolute"
                    style={{
                      left: pctX(box.x),
                      top: pctY(box.y),
                      width: pctX(box.w),
                      height: pctY(box.h),
                    }}
                  >
                    <StageNode
                      stage={stage(id)}
                      selected={selected === id}
                      active={active === id}
                      onSelect={(next) => setSelected((cur) => (cur === next ? null : next))}
                      layout="desktop"
                    />
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <ol className="flex gap-2 overflow-x-auto snap-x pb-1 -mx-1 px-1 list-none m-0">
            {STAGE_ORDER.map((id) => (
              <li key={id} className="snap-start shrink-0 w-[132px]">
                <StageNode
                  stage={stage(id)}
                  selected={selected === id}
                  active={active === id}
                  onSelect={(next) => setSelected((cur) => (cur === next ? null : next))}
                  layout="mobile"
                />
              </li>
            ))}
          </ol>
        )}
      </nav>

      {selectedStage && (
        <div
          className="panel p-3 mt-2.5"
          data-testid="pipeline-detail"
          role="region"
          aria-label={`${selectedStage.label} detail`}
        >
          <p className="label !text-[10px]">{selectedStage.label}</p>
          <p className="text-[11.5px] text-muted mt-1">{selectedStage.hint}</p>
          <p className="label !text-[10px] !text-faint mt-1">
            {selectedStage.value} {selectedStage.unit} · as of {timeAgo(p.asOf, now)}
          </p>
        </div>
      )}
    </section>
  );
}
