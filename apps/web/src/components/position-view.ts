import type { DashboardState } from '../types';

/** Seconds to a compact clock label (2h 5m). */
export function hhmm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface Countdown {
  text: string;
  phase: 'hold' | 'grace' | 'now';
}

/**
 * Live time-exit countdown for a position: phase 1 decision at maxAge, force-close
 * at maxAge+grace. Everything here is in seconds, which is what `hhmm` formats.
 */
export function countdown(
  p: DashboardState['positions'][number],
  maxAgeHours: number,
  graceHours: number,
  now: number,
): Countdown {
  const opened = Date.parse(p.openedIso);
  const ageSec = Number.isFinite(opened) ? Math.max(0, Math.round((now - opened) / 1000)) : 0;
  const endSec = (maxAgeHours + graceHours) * 3_600;
  if (ageSec >= endSec) return { text: 'SELLS NOW', phase: 'now' };
  if (ageSec >= maxAgeHours * 3_600)
    return { text: `GRACE · SELLS IN ${hhmm(endSec - ageSec)}`, phase: 'grace' };
  return { text: `TIME EXIT IN ${hhmm(maxAgeHours * 3_600 - ageSec)}`, phase: 'hold' };
}

/** Text and colours for a position's status pill. */
export function posChip(status: string): { label: string; cls: string } {
  switch (status) {
    case 'open':
      return { label: 'OPEN', cls: 'bg-posdim text-pos' };
    case 'partially_closed':
      return { label: 'PARTIAL', cls: 'bg-warndim text-warn' };
    case 'requires_reconciliation':
      return { label: 'RECONCILE', cls: 'bg-infodim text-info' };
    default:
      return { label: status.toUpperCase(), cls: 'text-faint' };
  }
}
