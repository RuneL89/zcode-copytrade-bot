/**
 * Programs whose logs are worth a getTransaction. Anything else (airdrops,
 * transfers, spam) is ignored so a roster stream does not pay to fetch it.
 */
export const SWAP_PROGRAM_IDS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
  'FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X',
] as const;

export function logsLookLikeSwap(logs: readonly string[]): boolean {
  const blob = logs.join('\n');
  return SWAP_PROGRAM_IDS.some((id) => blob.includes(id));
}

export interface LogsNotification {
  signature: string;
  err: boolean;
  logs: string[];
}

/** Pull a Helius/standard logsNotification out of a WebSocket message. */
export function parseLogsNotification(message: unknown): LogsNotification | null {
  if (!message || typeof message !== 'object') return null;
  const method = (message as { method?: unknown }).method;
  if (method !== 'logsNotification') return null;
  const value = (
    message as { params?: { result?: { value?: { signature?: unknown; err?: unknown; logs?: unknown } } } }
  ).params?.result?.value;
  if (!value || typeof value.signature !== 'string' || !Array.isArray(value.logs)) return null;
  const logs = value.logs.filter((line): line is string => typeof line === 'string');
  return { signature: value.signature, err: value.err != null, logs };
}
