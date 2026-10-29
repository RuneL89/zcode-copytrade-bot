import { describe, expect, it } from 'vitest';
import { selectDawnTargets, type DawnTargetInput } from '../src/services/dawn-targets.js';

function cand(id: string, observedAt: string, statsCheckedAt: string | null): DawnTargetInput {
  return { candidateId: id, handle: id, observedAt, statsCheckedAt };
}

describe('selectDawnTargets', () => {
  const now = '2026-10-29T16:00:00Z';
  const staleCutoff = '2026-10-28T16:00:00Z';

  it('orders walletless candidates freshest-board-first', () => {
    const pool = [
      cand('old', '2026-10-28T10:00:00Z', null),
      cand('new', '2026-10-29T13:00:00Z', null),
      cand('mid', '2026-10-29T06:00:00Z', null),
    ];
    const targets = selectDawnTargets(pool, new Set(), staleCutoff, 10);
    expect(targets.map((t) => t.candidateId)).toEqual(['new', 'mid', 'old']);
  });

  it('orders stale-stats candidates oldest-stats-first with nulls first', () => {
    const pool = [
      cand('a', '2026-10-29T13:00:00Z', '2026-10-28T08:00:00Z'),
      cand('b', '2026-10-29T12:00:00Z', null),
      cand('c', '2026-10-29T14:00:00Z', '2026-10-27T08:00:00Z'),
      cand('fresh-stats', '2026-10-29T15:00:00Z', '2026-10-29T15:00:00Z'),
    ];
    const targets = selectDawnTargets(pool, new Set(['a', 'b', 'c', 'fresh-stats']), staleCutoff, 10);
    // nulls first, then oldest stats; candidates with post-cutoff stats are not targets.
    expect(targets.map((t) => t.candidateId)).toEqual(['b', 'c', 'a']);
  });

  it('serves walletless before stale-stats and respects the cap across the concat', () => {
    const pool = [
      cand('stale1', '2026-10-29T13:00:00Z', '2026-10-27T00:00:00Z'),
      cand('walletless1', '2026-10-29T14:00:00Z', null),
      cand('stale2', '2026-10-29T12:00:00Z', '2026-10-28T00:00:00Z'),
      cand('walletless2', '2026-10-29T09:00:00Z', null),
      cand('fresh', '2026-10-29T15:00:00Z', '2026-10-29T15:00:00Z'),
    ];
    const wallets = new Set(['stale1', 'stale2', 'fresh']);
    const targets = selectDawnTargets(pool, wallets, staleCutoff, 3);
    // walletless (freshest board first), then the stalest stats — stale1 (Oct 27) before stale2 (Oct 28).
    expect(targets.map((t) => t.candidateId)).toEqual(['walletless1', 'walletless2', 'stale1']);
  });

  it('returns nothing when every candidate has a wallet and fresh stats', () => {
    const pool = [cand('fresh', '2026-10-29T15:00:00Z', now)];
    expect(selectDawnTargets(pool, new Set(['fresh']), staleCutoff, 25)).toEqual([]);
  });
});
