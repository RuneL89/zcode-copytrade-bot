import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTimersAvoidFullHistory } from '@zcode-bot/core';
import { RosterStream } from '../src/services/rosterStream.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

describe('roster stream', () => {
  it('fetches a swap log and ignores a transfer', () => {
    const stream = new RosterStream();
    const seen: string[] = [];
    stream.handleLogs(
      'seat',
      { signature: 'airdrop', err: false, logs: ['Program 11111111111111111111111111111111 invoke [1]'] },
      (address, signature) => seen.push(`${address}:${signature}`),
    );
    stream.handleLogs(
      'seat',
      {
        signature: 'swap',
        err: false,
        logs: ['Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]'],
      },
      (address, signature) => seen.push(`${address}:${signature}`),
    );
    expect(seen).toEqual(['seat:swap']);
  });

  it('falls back to signature-first only after the socket has been down for 60s', () => {
    const stream = new RosterStream();
    stream.markDown(0);
    expect(stream.mode(60_000)).toBe('push');
    expect(stream.mode(60_001)).toBe('outage');
    stream.markUp();
    expect(stream.mode(120_000)).toBe('push');
  });
});

describe('timer call pattern', () => {
  it('does not let a timer file request full transaction history', () => {
    const files = [
      'apps/server/src/services/monitor.ts',
      'apps/server/src/services/watch.ts',
      'apps/server/src/services/rosterStream.ts',
      'apps/server/src/runtime.ts',
    ].map((name) => ({ name, source: readFileSync(resolve(ROOT, name), 'utf8') }));
    expect(() => assertTimersAvoidFullHistory(files)).not.toThrow();
  });
});
