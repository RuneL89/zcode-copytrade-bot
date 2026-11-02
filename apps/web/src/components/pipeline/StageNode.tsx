import type { StageId } from './layout';

/** What one stage node renders — the numbers come from `DashboardState.pipeline`. */
export interface StageView {
  id: StageId;
  label: string;
  value: number;
  unit: string;
  hint: string;
  /** Full accessible name, counts included (e.g. "Pool: 148 candidates, 47 buyers"). */
  aria: string;
}

/**
 * One pipeline stage. It is a real button (keyboard-reachable, ≥44px) whether it
 * sits in the desktop spine or the mobile stepper; the caller positions it.
 */
export function StageNode({
  stage,
  selected,
  active,
  onSelect,
  layout,
}: {
  stage: StageView;
  selected: boolean;
  active: boolean;
  onSelect: (id: StageId) => void;
  layout: 'desktop' | 'mobile';
}) {
  return (
    <button
      type="button"
      data-testid={`pipeline-stage-${stage.id}`}
      data-stage={stage.id}
      aria-label={stage.aria}
      aria-pressed={selected}
      onClick={() => onSelect(stage.id)}
      className={[
        'h-full w-full text-left cursor-pointer rounded-[12px] border transition-colors',
        'bg-glass border-glassborder hover:border-accentborder',
        'flex flex-col justify-between',
        layout === 'desktop' ? 'p-3' : 'min-h-[48px] p-2.5',
        selected ? 'border-accentborder bg-accentdim' : '',
        active ? 'node-pulse' : '',
      ].join(' ')}
    >
      <span className="flex items-center gap-1.5">
        <span className="label !text-[10px] !text-muted">{stage.label}</span>
        <span
          className={`ml-auto inline-block w-1.5 h-1.5 rounded-full ${stage.value > 0 ? 'bg-pos' : 'bg-faint'}`}
          aria-hidden="true"
        />
      </span>
      <span className="money text-[24px] leading-none font-bold mt-1.5" data-stage-value>
        {stage.value}
      </span>
      <span className="label !text-[10px] !text-faint mt-1 leading-snug">{stage.unit}</span>
    </button>
  );
}
