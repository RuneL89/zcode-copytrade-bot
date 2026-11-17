/**
 * Deploy-only fetch/WebSocket hook. Counts Helius and Fomo credit spend
 * without logging URLs, keys, or bodies. Loaded via NODE_OPTIONS --import.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HELIUS_LOG = process.env.HELIUS_METER_LOG || '/home/box/copydesk/logs/helius-credits.jsonl';
const FOMO_LOG = process.env.FOMO_METER_LOG || '/home/box/copydesk/logs/fomo-credits.jsonl';
const WSS_CHUNK_BYTES = 100_000;
const WSS_CREDITS_PER_CHUNK = 2;

const METHOD_CREDITS = {
  getTransaction: 1,
  getSignaturesForAddress: 1,
  getTransactionsForAddress: 10,
  getSlot: 1,
  getBalance: 1,
  getTokenAccountBalance: 1,
  getTokenAccountsByOwner: 1,
  getAccountInfo: 1,
  getLatestBlockhash: 1,
  getSignatureStatuses: 1,
  sendTransaction: 1,
  getMultipleAccounts: 1,
  logsSubscribe: 0,
  logsUnsubscribe: 0,
};

function hostOf(input) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!raw) return '';
    return new URL(raw).host;
  } catch {
    return '';
  }
}

function isHeliusHost(host) {
  return host.includes('helius-rpc.com') || host.includes('helius.xyz') || host.includes('helius.dev');
}

function rpcMethod(init) {
  const body = init?.body;
  if (typeof body !== 'string') return 'unknown';
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return 'batch';
    return typeof parsed?.method === 'string' ? parsed.method : 'unknown';
  } catch {
    return 'unparsed';
  }
}

function append(file, row) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + '\n');
  } catch {
    // Metering must never break the process.
  }
}

const origFetch = globalThis.fetch;
globalThis.fetch = async function meteredFetch(input, init) {
  const host = hostOf(input);
  const started = Date.now();
  const result = await origFetch.apply(this, arguments);
  try {
    if (isHeliusHost(host)) {
      const method = rpcMethod(init);
      const credits = METHOD_CREDITS[method] ?? 1;
      append(HELIUS_LOG, {
        ts: started,
        host,
        method,
        credits,
        status: result.status,
        flagged: !(method in METHOD_CREDITS),
        transport: 'http',
      });
    } else if (host.includes('fomoapi')) {
      const remaining = result.headers?.get?.('x-credits-remaining') ?? null;
      const costHeader =
        result.headers?.get?.('x-credits-cost') ?? result.headers?.get?.('x-credits-spent') ?? null;
      const cost = costHeader != null && Number.isFinite(Number(costHeader)) ? Number(costHeader) : 250;
      append(FOMO_LOG, {
        ts: started,
        host,
        status: result.status,
        credits: cost,
        creditsRemaining:
          remaining != null && Number.isFinite(Number(remaining)) ? Number(remaining) : remaining,
      });
    }
  } catch {
    // ignore
  }
  return result;
};

const OrigWebSocket = globalThis.WebSocket;
if (OrigWebSocket) {
  globalThis.WebSocket = class MeteredWebSocket extends OrigWebSocket {
    constructor(url, protocols) {
      const host = hostOf(url);
      super(url, protocols);
      if (!isHeliusHost(host)) return;
      let pending = 0;
      const note = (byteLength, kind) => {
        if (!byteLength || byteLength <= 0) return;
        pending += byteLength;
        const units = Math.floor(pending / WSS_CHUNK_BYTES);
        // Always record the raw bytes so short sessions can be projected.
        append(HELIUS_LOG, {
          ts: Date.now(),
          host,
          method: 'wssChunk',
          credits: units * WSS_CREDITS_PER_CHUNK,
          bytes: byteLength,
          pending,
          units,
          kind,
          transport: 'ws',
          flagged: false,
        });
        if (units > 0) pending -= units * WSS_CHUNK_BYTES;
      };
      this.addEventListener('message', (ev) => {
        try {
          const data = ev.data;
          const n =
            typeof data === 'string'
              ? Buffer.byteLength(data)
              : data instanceof ArrayBuffer
                ? data.byteLength
                : ArrayBuffer.isView(data)
                  ? data.byteLength
                  : 0;
          note(n, 'message');
        } catch {
          // ignore
        }
      });
      this.addEventListener('open', () => {
        append(HELIUS_LOG, {
          ts: Date.now(),
          host,
          method: 'wssOpen',
          credits: 0,
          transport: 'ws',
          flagged: false,
        });
      });
    }
  };
}
