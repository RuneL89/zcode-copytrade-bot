/**
 * Helius Admin API usage. The RPC key is sent as `X-Api-Key`. A Bearer token
 * is rejected with 401. This call is not an RPC credit. A 401 or 403 means
 * the admin endpoint is unavailable to this key; the caller keeps the in-app
 * meter and does not invent a figure.
 */

export interface HeliusUsageReport {
  creditsUsed: number;
  creditsRemaining: number | null;
  creditCycle: string | null;
}

export class HeliusUsageError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly unavailable: boolean,
  ) {
    super(message);
  }
}

export async function fetchHeliusProjectUsage(args: {
  projectId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<HeliusUsageReport> {
  const projectId = args.projectId.trim();
  const apiKey = args.apiKey.trim();
  if (!projectId) throw new HeliusUsageError('helius usage: project id is empty', null, true);
  if (!apiKey) throw new HeliusUsageError('helius usage: API key is empty', null, true);
  const url = `https://admin-api.helius.xyz/v0/admin/projects/${encodeURIComponent(projectId)}/usage`;
  const res = await (args.fetchImpl ?? fetch)(url, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new HeliusUsageError(
      `helius usage HTTP ${res.status}: the admin endpoint did not accept this API key`,
      res.status,
      true,
    );
  }
  if (!res.ok) throw new HeliusUsageError(`helius usage HTTP ${res.status}`, res.status, false);
  const json = (await res.json()) as Record<string, unknown>;
  const creditsUsed = numberField(json, 'creditsUsed');
  if (creditsUsed === null)
    throw new HeliusUsageError('helius usage: creditsUsed missing', res.status, false);
  return {
    creditsUsed,
    creditsRemaining: numberField(json, 'creditsRemaining'),
    creditCycle: cycleOf(json.creditCycle),
  };
}

function cycleOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value && typeof value === 'object' && 'start' in value) {
    const start = (value as { start?: unknown }).start;
    return typeof start === 'string' ? start : null;
  }
  return null;
}

function numberField(json: Record<string, unknown>, key: string): number | null {
  const value = json[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}
