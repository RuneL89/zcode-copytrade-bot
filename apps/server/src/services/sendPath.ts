/**
 * Land a signed transaction. Sender (0 credits, SWQOS tip already in the
 * transaction) is tried first. A response that contains no signature falls
 * through to a staked Helius sendTransaction (1 credit) and then the public
 * RPC. A transport error after the request left the process is unknown:
 * the same bytes are not submitted again.
 */

export const SENDER_URL = 'https://sender.helius-rpc.com/fast';
/** Published Helius Sender tip accounts (mainnet). SWQOS minimum is 5_000 lamports. */
export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
] as const;
export const SENDER_TIP_LAMPORTS = 5_000;

export type SendResult =
  | { kind: 'sent'; signature: string; via: 'sender' | 'staked' | 'public' }
  | { kind: 'failed'; error: string }
  | { kind: 'unknown'; detail: string };

interface RpcBody {
  result?: unknown;
  error?: { message?: string };
}

async function postSend(
  url: string,
  signedBase64: string,
  fetchImpl: typeof fetch,
): Promise<{ signature?: string; error?: string; transport?: boolean }> {
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
    return { transport: true, error: (error as Error).message };
  }
  let json: RpcBody;
  try {
    json = (await res.json()) as RpcBody;
  } catch (error) {
    return { transport: true, error: (error as Error).message };
  }
  if (typeof json.result === 'string' && json.result.length > 0) return { signature: json.result };
  return { error: json.error?.message ?? `HTTP ${res.status}` };
}

export async function sendSignedTransaction(args: {
  signedBase64: string;
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
  const attempts: string[] = [];
  if (args.trySender !== false) {
    const sender = new URL(SENDER_URL);
    sender.searchParams.set('swqos_only', 'true');
    if (args.apiKey) sender.searchParams.set('api-key', args.apiKey);
    const sent = await postSend(sender.toString(), args.signedBase64, fetchImpl);
    if (sent.signature) return { kind: 'sent', signature: sent.signature, via: 'sender' };
    if (sent.transport) return { kind: 'unknown', detail: `sender transport: ${sent.error}` };
    attempts.push(`sender: ${sent.error}`);
  }
  if (args.allowStaked?.() !== false) {
    args.onStakedSend?.();
    const staked = await postSend(args.heliusRpcUrl, args.signedBase64, fetchImpl);
    if (staked.signature) return { kind: 'sent', signature: staked.signature, via: 'staked' };
    if (staked.transport) return { kind: 'unknown', detail: `staked transport: ${staked.error}` };
    attempts.push(`staked: ${staked.error}`);
  }
  const pub = await postSend(args.publicRpcUrl, args.signedBase64, fetchImpl);
  if (pub.signature) return { kind: 'sent', signature: pub.signature, via: 'public' };
  if (pub.transport) return { kind: 'unknown', detail: `public transport: ${pub.error}` };
  attempts.push(`public: ${pub.error}`);
  return { kind: 'failed', error: attempts.join('; ') };
}
