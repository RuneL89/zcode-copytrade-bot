import { describe, expect, it } from 'vitest';
import { durationLabel } from '../src/redesign/format';
import { positionTimeLeftLabel, positionTimeLeftPhase } from '../src/redesign/model';

/**
 * "time left" must not call a profitable position's post-max-hold window
 * "grace": grace is the losing-position window. A green position past max hold
 * is simply due for the sell-on-green exit.
 */
describe('redesign position time-left label', () => {
  it('counts down while the max-hold clock is still running', () => {
    const position = { timeLeftMs: 5 * 60_000, unrealizedUsdMicro: 1_000_000n };
    expect(positionTimeLeftPhase(position)).toBe('hold');
    expect(positionTimeLeftLabel(position)).toBe('5m');
    expect(positionTimeLeftLabel(position, durationLabel)).toBe('5m');
  });

  it('shows hours in the seats table while holding', () => {
    const position = { timeLeftMs: (4 * 60 + 55) * 60_000, unrealizedUsdMicro: -1_000_000n };
    expect(positionTimeLeftLabel(position, durationLabel)).toBe('4h 55m');
  });

  it('marks a green position past max hold as exit due, not grace', () => {
    const position = { timeLeftMs: -60_000, unrealizedUsdMicro: 3_080_000n };
    expect(positionTimeLeftPhase(position)).toBe('exit_due');
    expect(positionTimeLeftLabel(position)).toBe('exit due');
  });

  it('keeps grace for a red position past max hold', () => {
    const position = { timeLeftMs: -60_000, unrealizedUsdMicro: -500_000n };
    expect(positionTimeLeftPhase(position)).toBe('grace');
    expect(positionTimeLeftLabel(position)).toBe('grace');
  });

  it('treats an unmarked position past max hold as grace', () => {
    const position = { timeLeftMs: -60_000, unrealizedUsdMicro: null };
    expect(positionTimeLeftPhase(position)).toBe('grace');
  });
});
