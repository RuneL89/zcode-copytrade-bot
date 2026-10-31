import { describe, expect, it } from 'vitest';
import { deriveJustFiredExclusion, type ActivationLike } from '../src/eligibility.js';

const act = (
  candidateId: string,
  state: string,
  startedAt: string,
  endedAt: string | null = null,
): ActivationLike => ({ candidateId, state, startedAt, endedAt });

describe('deriveJustFiredExclusion', () => {
  it('returns null when there are no fired activations', () => {
    const activations = [act('cand_a', 'ACTIVE', '2026-10-31T10:00:00Z')];
    expect(deriveJustFiredExclusion(activations)).toBeNull();
    expect(deriveJustFiredExclusion([])).toBeNull();
  });

  it('excludes the just-fired trader while nobody else has been hired', () => {
    const activations = [
      act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T12:00:00Z'),
    ];
    expect(deriveJustFiredExclusion(activations)).toEqual({
      candidateId: 'cand_jim',
      firedAt: '2026-10-31T12:00:00Z',
    });
  });

  it('lifts the exclusion once a different trader is activated', () => {
    const activations = [
      // Bob was hired after jim's fire -> ban on jim lifted.
      act('cand_bob', 'ACTIVE', '2026-10-31T12:00:01Z'),
      act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T12:00:00Z'),
    ];
    expect(deriveJustFiredExclusion(activations)).toBeNull();
  });

  it('keeps the exclusion when the same trader was manually rehired', () => {
    const activations = [
      act('cand_jim', 'ACTIVE', '2026-10-31T12:00:01Z'),
      act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T12:00:00Z'),
    ];
    // Moot while jim is active, but the derivation must not treat jim's own
    // rehire as "someone else held the seat".
    expect(deriveJustFiredExclusion(activations)).toEqual({
      candidateId: 'cand_jim',
      firedAt: '2026-10-31T12:00:00Z',
    });
  });

  it('lifts the exclusion when the different hire starts in the same millisecond the fire ended', () => {
    const activations = [
      act('cand_bob', 'ACTIVE', '2026-10-31T12:00:00Z'),
      act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T12:00:00Z'),
    ];
    expect(deriveJustFiredExclusion(activations)).toBeNull();
  });

  it('uses the most recent fire when several fired activations exist', () => {
    const activations = [
      act('cand_jim', 'FIRED', '2026-10-30T08:00:00Z', '2026-10-30T09:00:00Z'),
      act('cand_bob', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T09:00:00Z'),
    ];
    // Jim's ban was lifted by bob's hire; bob is the one excluded now.
    expect(deriveJustFiredExclusion(activations)).toEqual({
      candidateId: 'cand_bob',
      firedAt: '2026-10-31T09:00:00Z',
    });
  });

  it('ignores FIRED rows without an endedAt', () => {
    const activations = [act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z')];
    expect(deriveJustFiredExclusion(activations)).toBeNull();
  });

  it('ignores a different-candidate activation that started before the fire ended', () => {
    const activations = [
      act('cand_bob', 'FIRED', '2026-10-31T06:00:00Z', '2026-10-31T07:00:00Z'),
      act('cand_jim', 'FIRED', '2026-10-31T08:00:00Z', '2026-10-31T12:00:00Z'),
    ];
    // Bob's activation predates jim's fire; jim is still the exclusion.
    expect(deriveJustFiredExclusion(activations)).toEqual({
      candidateId: 'cand_jim',
      firedAt: '2026-10-31T12:00:00Z',
    });
  });
});
