import { CreditGovernor, logsLookLikeSwap } from '@zcode-bot/core';
import { RosterStream } from './rosterStream.js';

/** 0.1 MB, decimal, matching Helius's "2 credits per 0.1 MB" websocket price. */
export const WSS_CHUNK_BYTES = 100_000;
export const SAFETY_POLL_MS = 5 * 60_000;
export const OUTAGE_POLL_MS = 45_000;
export const OUTAGE_AFTER_MS = 60_000;
export const MAX_STREAM_SEATS = 5;

export interface PushSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: { data?: unknown }) => void): void;
}

export interface RosterPushOptions {
  apiKey: string;
  governor: CreditGovernor;
  seats: () => string[];
  onSwap: (address: string, signature: string) => void;
  gapFill: (address: string) => Promise<void>;
  openSocket: (url: string) => PushSocket;
  now?: () => number;
  onMode?: (mode: 'push' | 'outage', pollMs: number) => void;
}

/**
 * One Helius `logsSubscribe` connection for up to five hired seats, plus a
 * hot spare that subscribes only after the primary drops. Bytes are metered
 * on the roster bucket. When the governor refuses, or both sockets stay down
 * for 60s, the caller is told to poll signature-first on the outage reserve.
 */
export class HeliusRosterPush {
  readonly stream = new RosterStream();
  private primary: PushSocket | null = null;
  private spare: PushSocket | null = null;
  private spareLive = false;
  private active: 'primary' | 'spare' | 'down' = 'down';
  private bytesPending = 0;
  private stopped = false;
  private subToAddress = new Map<number, string>();
  private nextId = 1;

  constructor(private opts: RosterPushOptions) {}

  start(): void {
    this.open('primary');
    this.open('spare');
  }

  stop(): void {
    this.stopped = true;
    this.primary?.close();
    this.spare?.close();
  }

  mode(nowMs = this.now()): 'push' | 'outage' {
    return this.stream.mode(nowMs);
  }

  /** Re-evaluate push versus outage. Tests advance the clock and call this. */
  tickMode(): void {
    this.reportMode();
  }

  /**
   * Subscribe any hired seat that joined after the socket opened. A hire that
   * waits for the 5-minute safety poll only sees buys that are already older
   * than the 90s copy window.
   */
  refreshSeats(): string[] {
    if (this.stopped || this.active === 'down') return [];
    const socket = this.active === 'primary' ? this.primary : this.spare;
    if (!socket) return [];
    const known = new Set(this.subToAddress.values());
    const added = this.seatList().filter((address) => !known.has(address));
    for (const address of added) this.sendSubscribe(socket, address);
    return added;
  }

  /** Charge websocket payload. Returns false when the roster bucket refuses. */
  noteBytes(byteLength: number, atMs = this.now()): boolean {
    if (byteLength <= 0) return true;
    this.bytesPending += byteLength;
    const units = Math.floor(this.bytesPending / WSS_CHUNK_BYTES);
    if (units <= 0) return true;
    const decision = this.opts.governor.spend({
      path: 'roster',
      method: 'wssChunk',
      units,
      atMs,
    });
    if (!decision.ok) return false;
    this.bytesPending -= units * WSS_CHUNK_BYTES;
    return true;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private url(): string {
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.opts.apiKey)}`;
  }

  private open(which: 'primary' | 'spare'): void {
    if (this.stopped) return;
    const socket = this.opts.openSocket(this.url());
    if (which === 'primary') this.primary = socket;
    else this.spare = socket;
    socket.addEventListener('open', () => {
      if (which === 'spare') {
        this.spareLive = true;
        return;
      }
      this.becomeActive('primary', socket);
    });
    socket.addEventListener('message', (ev) => {
      if (which === 'primary' && this.active !== 'primary') return;
      if (which === 'spare' && this.active !== 'spare') return;
      this.onMessage(ev.data);
    });
    socket.addEventListener('close', () => {
      if (which === 'spare') this.spareLive = false;
      if (this.active !== which) return;
      this.active = 'down';
      this.stream.markDown(this.now());
      this.reportMode();
      if (which === 'primary' && this.spareLive && this.spare) this.becomeActive('spare', this.spare);
      if (!this.stopped) setTimeout(() => this.open(which), 5_000);
    });
  }

  private becomeActive(which: 'primary' | 'spare', socket: PushSocket): void {
    this.active = which;
    this.stream.markUp();
    this.subToAddress.clear();
    this.subscribe(socket);
    this.reportMode();
    for (const address of this.seatList()) {
      void this.opts.gapFill(address).catch(() => undefined);
    }
  }

  private seatList(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const address of this.opts.seats()) {
      if (!address || seen.has(address)) continue;
      seen.add(address);
      out.push(address);
      if (out.length >= MAX_STREAM_SEATS) break;
    }
    return out;
  }

  private subscribe(socket: PushSocket): void {
    for (const address of this.seatList()) this.sendSubscribe(socket, address);
  }

  private sendSubscribe(socket: PushSocket, address: string): void {
    const id = this.nextId++;
    this.subToAddress.set(id, address);
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [address] }, { commitment: 'confirmed' }],
      }),
    );
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : '';
    if (!this.noteBytes(text.length)) {
      this.primary?.close();
      this.spare?.close();
      this.active = 'down';
      this.stream.markDown(this.now());
      this.reportMode();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const record = message as {
      id?: number;
      result?: number;
      method?: string;
      params?: {
        subscription?: number;
        result?: { value?: { signature?: unknown; err?: unknown; logs?: unknown } };
      };
    };
    if (typeof record.id === 'number' && typeof record.result === 'number') {
      const address = this.subToAddress.get(record.id);
      if (address) this.subToAddress.set(record.result, address);
      return;
    }
    if (record.method !== 'logsNotification') return;
    const value = record.params?.result?.value;
    if (!value || typeof value.signature !== 'string' || !Array.isArray(value.logs)) return;
    const logs = value.logs.filter((line): line is string => typeof line === 'string');
    if (value.err != null || !logsLookLikeSwap(logs)) return;
    const address =
      typeof record.params?.subscription === 'number'
        ? this.subToAddress.get(record.params.subscription)
        : undefined;
    if (!address) return;
    this.opts.onSwap(address, value.signature);
  }

  private reportMode(): void {
    const mode = this.mode();
    this.opts.onMode?.(mode, mode === 'outage' ? OUTAGE_POLL_MS : SAFETY_POLL_MS);
  }
}

export function browserSocket(url: string): PushSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    addEventListener: (type, cb) => {
      ws.addEventListener(type, (ev) => {
        cb({ data: 'data' in ev ? (ev as MessageEvent).data : undefined });
      });
    },
  };
}
