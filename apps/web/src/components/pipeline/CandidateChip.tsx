import type { EdgeGeometry } from './layout';

/**
 * One candidate chip riding its edge for 1.2s (plan 07). Rendered only when a
 * transition count increased and motion is allowed; under
 * `prefers-reduced-motion` PipelineFlow never spawns one and the CSS also hides
 * it — the counts still update either way. The chip is decorative inside the
 * aria-hidden SVG, so it carries `data-chip` for tests only.
 */
export function CandidateChip({ edge, id }: { edge: EdgeGeometry; id: number }) {
  return (
    <circle key={id} data-chip r={4} fill="var(--color-flow)">
      <animateMotion dur="1.2s" fill="freeze" path={edge.path} />
    </circle>
  );
}
