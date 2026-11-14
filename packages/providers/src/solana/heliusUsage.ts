/**
 * Helius Admin API usage. This is not an RPC credit. A missing or unreadable
 * body fails closed: the caller keeps the in-app meter and does not invent a
 * figure.
 */

export interface HeliusUsageReport {
  creditsUsed: number;
  creditsRemaining: number | null;
  creditCycle: string | null;
}

export async function fetchHeliusProjectUsage(args: {
  projectId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<HeliusUsageReport> {
  const projectId = args.projectId.trim();
  const apiKey = args.apiKey.trim();
  if (!projectId) throw new Error('helius usage: project id is empty');
  if (!apiKey) throw new Error('helius usage: API key is empty');
  const url = `https://admin-api.helius.xyz/v0/admin/projects/${encodeURIComponent(projectId)}/usage`;
  const res = await (args.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`helius usage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  const creditsUsed = numberField(json, 'creditsUsed');
  if (creditsUsed === null) throw new Error('helius usage: creditsUsed missing');
  return {
    creditsUsed,
    creditsRemaining: numberField(json, 'creditsRemaining'),
    creditCycle: typeof json.creditCycle === 'string' ? json.creditCycle : null,
  };
}

function numberField(json: Record<string, unknown>, key: string): number | null {
  const value = json[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}
