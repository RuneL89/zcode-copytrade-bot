import { describe, expect, it } from 'vitest';
import { DEFAULT_DAWN_CONFIG, DawnNoCardError } from '../src/dawn/dawn-lookup.js';

describe('Dawn silent-bot policy', () => {
  it('retries a silent handle once after 30 seconds', () => {
    expect(DEFAULT_DAWN_CONFIG.maxNoCardAttempts).toBe(2);
    expect(DEFAULT_DAWN_CONFIG.noCardRetryDelayMs).toBe(30_000);
    // The retry must stay well inside one lookup run so other targets wait at
    // most ~2x the reply window for a dead profile.
    expect(DEFAULT_DAWN_CONFIG.noCardRetryDelayMs + 2 * DEFAULT_DAWN_CONFIG.replyTimeoutMs).toBeLessThan(
      5 * 60_000,
    );
  });

  it('types a silent result distinctly so callers can note-and-continue', () => {
    const err = new DawnNoCardError('GrimRigidGoat', '2 attempt(s)');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DawnNoCardError');
    expect(err.handle).toBe('GrimRigidGoat');
    expect(err.message).toContain('@GrimRigidGoat');
  });
});
