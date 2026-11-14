import { describe, expect, it } from 'vitest';
import { CreditGovernor, PATH_BUDGETS } from '@zcode-bot/core';
import { fetchHeliusProjectUsage } from '@zcode-bot/providers';
import {
  HeliusRosterPush,
  OUTAGE_POLL_MS,
  SAFETY_POLL_MS,
  WSS_CHUNK_BYTES,
  type PushSocket,
} from '../src/services/heliusStream.js';

class FakeSocket implements PushSocket {
  sent: string[] = [];
  listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', {});
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, ev: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function harness(governor = new CreditGovernor()) {
  const sockets: FakeSocket[] = [];
  const swaps: Array<{ address: string; signature: string }> = [];
  const gaps: string[] = [];
  const modes: Array<{ mode: string; pollMs: number }> = [];
  let now = 0;
  const push = new HeliusRosterPush({
    apiKey: 'test-key',
    governor,
    seats: () => ['SeatA', 'SeatB', 'SeatC', 'SeatD', 'SeatE', 'SeatF'],
    onSwap: (address, signature) => swaps.push({ address, signature }),
    gapFill: async (address) => {
      gaps.push(address);
    },
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    onMode: (mode, pollMs) => modes.push({ mode, pollMs }),
  });
  return {
    push,
    sockets,
    swaps,
    gaps,
    modes,
    setNow: (ms: number) => {
      now = ms;
    },
    governor,
  };
}

describe('Helius roster stream', () => {
  it('subscribes at most five seats and fetches only swap logs', () => {
    const h = harness();
    h.push.start();
    const primary = h.sockets[0]!;
    expect(primary.url).toContain('wss://mainnet.helius-rpc.com/');
    expect(primary.url).not.toContain('test-keytest');
    primary.emit('open', {});
    expect(primary.sent).toHaveLength(5);
    expect(primary.sent.some((body) => body.includes('SeatF'))).toBe(false);
    const sub = JSON.parse(primary.sent[0]!) as { id: number; method: string };
    expect(sub.method).toBe('logsSubscribe');
    primary.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: sub.id, result: 42 }) });
    primary.emit('message', {
      data: JSON.stringify({
        method: 'logsNotification',
        params: {
          subscription: 42,
          result: {
            value: {
              signature: 'airdrop',
              err: null,
              logs: ['Program 11111111111111111111111111111111 invoke [1]'],
            },
          },
        },
      }),
    });
    primary.emit('message', {
      data: JSON.stringify({
        method: 'logsNotification',
        params: {
          subscription: 42,
          result: { value: { signature: 'swap-sig', err: null, logs: [`Program ${JUP} invoke [1]`] } },
        },
      }),
    });
    expect(h.swaps).toEqual([{ address: 'SeatA', signature: 'swap-sig' }]);
    expect(h.gaps).toEqual(['SeatA', 'SeatB', 'SeatC', 'SeatD', 'SeatE']);
    expect(h.modes.at(-1)).toEqual({ mode: 'push', pollMs: SAFETY_POLL_MS });
  });

  it('meters websocket bytes on the roster bucket and stops when the bucket refuses', () => {
    const governor = new CreditGovernor({ caps: { roster: 2 } });
    const h = harness(governor);
    expect(h.push.noteBytes(WSS_CHUNK_BYTES - 1, 0)).toBe(true);
    expect(governor.snapshot(0).byPath.roster).toBe(0);
    expect(h.push.noteBytes(1, 0)).toBe(true);
    expect(governor.snapshot(0).byPath.roster).toBe(2);
    expect(h.push.noteBytes(WSS_CHUNK_BYTES, 0)).toBe(false);
    expect(governor.snapshot(0).byPath.roster).toBeLessThanOrEqual(PATH_BUDGETS.roster.capPerDay);
  });

  it('uses the outage poll, not a full-history method, after both sockets stay down', () => {
    const h = harness();
    h.push.start();
    h.sockets[0]!.emit('open', {});
    h.sockets[0]!.close();
    h.sockets[1]!.close();
    h.setNow(60_001);
    h.push.tickMode();
    expect(h.push.mode(60_001)).toBe('outage');
    expect(h.modes.at(-1)).toEqual({ mode: 'outage', pollMs: OUTAGE_POLL_MS });
  });
});

describe('Helius admin usage', () => {
  it('reads creditsUsed and fails closed when the body has no figure', async () => {
    const ok = await fetchHeliusProjectUsage({
      projectId: 'proj',
      apiKey: 'key',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ creditsUsed: 1200, creditsRemaining: 998800, creditCycle: '2026-11' }),
          {
            status: 200,
          },
        )) as typeof fetch,
    });
    expect(ok.creditsUsed).toBe(1200);
    await expect(
      fetchHeliusProjectUsage({
        projectId: 'proj',
        apiKey: 'key',
        fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/creditsUsed/);
    await expect(
      fetchHeliusProjectUsage({
        projectId: 'proj',
        apiKey: 'key',
        fetchImpl: (async () => new Response('no', { status: 403 })) as typeof fetch,
      }),
    ).rejects.toThrow(/403/);
  });
});
