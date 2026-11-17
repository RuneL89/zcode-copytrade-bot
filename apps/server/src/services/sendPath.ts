import bs58 from 'bs58';

/**
 * Land a signed transaction. Sender (0 credits, SWQOS tip already in the
 * transaction) is tried first, then a staked Helius send (1 credit), then the
 * public RPC. Every endpoint must return the signature of the locally signed
 * bytes. A transport error after the request left the process is ambiguous:
 * the same bytes are not re-sent to that endpoint, but the ladder may try
 * another endpoint (identical bytes are idempotent on-chain).
 */

export const SENDER_URL = 'https://sender.helius-rpc.com/fast';
export { SENDER_TIP_ACCOUNTS, SENDER_TIP_LAMPORTS } from '@zcode-bot/core';

export type SendResult =
  | { kind: 'sent'; signature: string; via: 'sender' | 'staked' | 'public' }
  | { kind: 'failed'; error: string; signature: string | null }
  | { kind: 'unknown'; detail: string; signature: string };

interface RpcBody {
  result?: unknown;
  error?: { code?: number; message?: string };
}

type PostOutcome =
  | { kind: 'sent'; signature: string }
  | { kind: 'already'; signature: string }
  | { kind: 'definitive'; error: string }
  | { kind: 'ambiguous'; error: string }
  | { kind: 'transport'; error: string };

const DEFINITIVE_PATTERNS =
  /simulation failed|transaction simulation failed|preflight failure|invalid transaction|signature verification|insufficient (funds|lamports)|blockhash not found|could not find blockhash|transaction (has )?expired|account not found|invalid account data/i;
const ALREADY_PATTERNS = /already (been )?processed|already in (the )?ledger/i;

/**
 * Classify a JSON-RPC send error. A preflight/simulation rejection is
 * definitive (nothing reached the chain). Everything else — rate limits,
 * 5xx, unknown provider text — is ambiguous and must be reconciled by
 * signature, never treated as "safe to retry as a new order".
 */
export function classifySendError(error: string): 'definitive' | 'ambiguous' | 'already' {
  if (ALREADY_PATTERNS.test(error)) return 'already';
  if (DEFINITIVE_PATTERNS.test(error)) return 'definitive';
  return 'ambiguous';
}

async function postSend(
  url: string,
  signedBase64: string,
  expectedSignature: string,
  fetchImpl: typeof fetch,
): Promise<PostOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'sendTransaction',
        params: [signedBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 0 }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { kind: 'transport', error: (error as Error).message };
  }

  const statusAmbiguous = !res.ok;
  let json: RpcBody;
  try {
    json = (await res.json()) as RpcBody;
  } catch (error) {
    return { kind: 'transport', error: `HTTP ${res.status}: ${(error as Error).message}` };
  }

  if (typeof json.result === 'string' && json.result.length > 0) {
    if (json.result !== expectedSignature) {
      return {
        kind: 'ambiguous',
        error: `provider returned signature ${json.result} for locally signed ${expectedSignature}`,
      };
    }
    // A matching signature from a non-2xx response is still not a confirmed
    // acceptance (a proxy can echo a body after an upstream failure).
    if (!res.ok) {
      return { kind: 'ambiguous', error: `HTTP ${res.status} with a matching signature` };
    }
    return { kind: 'sent', signature: json.result };
  }

  const text = json.error?.message ?? `HTTP ${res.status}`;
  const classification = classifySendError(text);
  if (classification === 'already') return { kind: 'already', signature: expectedSignature };
  if (classification === 'definitive' && !statusAmbiguous) return { kind: 'definitive', error: text };
  // A 429/5xx body may still carry an error message; the HTTP status makes the
  // request ambiguous even when the text looks like a preflight failure.
  return { kind: 'ambiguous', error: text };
}

export async function sendSignedTransaction(args: {
  signedBase64: string;
  /** Base58 signature of the locally signed transaction. Every response must match. */
  expectedSignature: string;
  heliusRpcUrl: string;
  publicRpcUrl: string;
  apiKey: string;
  /** When false, skip Sender (the transaction has no tip). */
  trySender?: boolean;
  /** When this returns false, skip the staked Helius send and try the public RPC. */
  allowStaked?: () => boolean;
  fetchImpl?: typeof fetch;
  onStakedSend?: () => void;
}): Promise<SendResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const expected = args.expectedSignature;
  const attempts: string[] = [];
  let ambiguous = false;

  const tryEndpoint = async (
    url: string,
    via: 'sender' | 'staked' | 'public',
  ): Promise<SendResult | null> => {
    const outcome = await postSend(url, args.signedBase64, expected, fetchImpl);
    if (outcome.kind === 'sent') return { kind: 'sent', signature: outcome.signature, via };
    if (outcome.kind === 'already') return { kind: 'sent', signature: expected, via };
    if (outcome.kind === 'transport') {
      // The request may have reached the provider. Never re-submit these bytes
      // to another endpoint: the outcome is unknown and must be reconciled.
      return {
        kind: 'unknown',
        detail: `${via} transport error: ${outcome.error}`,
        signature: expected,
      };
    }
    if (outcome.kind === 'ambiguous') ambiguous = true;
    attempts.push(`${via}: ${outcome.error}`);
    return null;
  };

  if (args.trySender !== false) {
    const sender = new URL(SENDER_URL);
    sender.searchParams.set('swqos_only', 'true');
    if (args.apiKey) sender.searchParams.set('api-key', args.apiKey);
    const sent = await tryEndpoint(sender.toString(), 'sender');
    if (sent) return sent;
  }

  if (args.allowStaked?.() !== false) {
    args.onStakedSend?.();
    const sent = await tryEndpoint(args.heliusRpcUrl, 'staked');
    if (sent) return sent;
  }

  const sent = await tryEndpoint(args.publicRpcUrl, 'public');
  if (sent) return sent;

  const joined = attempts.join('; ');
  if (ambiguous) {
    return { kind: 'unknown', detail: `send outcome ambiguous (${joined})`, signature: expected };
  }
  return { kind: 'failed', error: joined || 'send rejected', signature: null };
}

/** Base58 signature of a signed VersionedTransaction (for response matching). */
export function signatureOfSignedTransaction(signedBase64: string): string {
  // Avoid importing web3.js here; the first 64-byte signature of a serialized
  // transaction is prefixed by its compact-u16 signature count (always 1 for
  // the single-signer swaps we sign). web3.js is used by the caller for the
  // authoritative deserialize/verify; this helper is for tests and logging.
  const bytes = Buffer.from(signedBase64, 'base64');
  if (bytes.length < 2 || bytes[0] !== 1) throw new Error('expected a single-signature transaction');
  return bs58.encode(bytes.subarray(1, 65));
}
