/** API helpers: cookie sessions + double-submit CSRF header. */

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)zcode_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : '';
}

/** The CSRF cookie is a browser-session cookie that mobile browsers can drop
 * while the login cookie persists. When it is missing, ask the server for a
 * fresh one (GET /api/csrf) so mutations keep working. */
async function ensureCsrfToken(): Promise<string> {
  let token = csrfToken();
  if (!token) {
    await fetch('/api/csrf', { credentials: 'same-origin' });
    token = csrfToken();
  }
  return token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') {
      headers.set('x-csrf-token', await ensureCsrfToken());
    }
    return fetch(path, { ...init, headers, credentials: 'same-origin' });
  };
  let res = await send();
  // Self-heal: if the server still rejected the CSRF pair, refresh the token
  // once and retry before surfacing an error.
  if (res.status === 403 && init.method && init.method !== 'GET') {
    await fetch('/api/csrf', { credentials: 'same-origin' });
    res = await send();
  }
  if (res.status === 401 && !path.endsWith('/login')) {
    window.dispatchEvent(new CustomEvent('zcode:unauthorized'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  bootstrap: () => request<{ needsSetup: boolean; mode: string; armed: boolean }>('/api/bootstrap'),
  setup: (setupToken: string, username: string, password: string) =>
    request<{ ok: boolean }>('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ setupToken, username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  state: () => request<import('./types.js').DashboardState>('/api/state'),
  settings: () => request<Record<string, unknown>>('/api/settings'),
  patchSettings: (patch: Record<string, unknown>) =>
    request<{ ok: boolean; risk: Record<string, number | string> }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  importLeaderboard: (format: 'json' | 'csv', content: string) =>
    request<{ ok: boolean; entries: number; warnings: string[] }>('/api/import/leaderboard', {
      method: 'POST',
      body: JSON.stringify({ format, content }),
    }),
  activate: (candidateId: string) =>
    request<{ ok: boolean }>('/api/activate', { method: 'POST', body: JSON.stringify({ candidateId }) }),
  // The roster addresses one chair: the dashboard always names the activation.
  fire: (activationId: string) =>
    request<{ ok: boolean }>('/api/fire', { method: 'POST', body: JSON.stringify({ activationId }) }),
  pause: (reason?: string) =>
    request<{ ok: boolean }>('/api/control/pause', { method: 'POST', body: JSON.stringify({ reason }) }),
  resume: () => request<{ ok: boolean }>('/api/control/resume', { method: 'POST', body: '{}' }),
  emergencyStop: () =>
    request<{ ok: boolean }>('/api/control/emergency-stop', { method: 'POST', body: '{}' }),
  emergencyClear: () =>
    request<{ ok: boolean }>('/api/control/emergency-clear', { method: 'POST', body: '{}' }),
  closeAll: () =>
    request<{ ok: boolean; result?: { closed: number; unknown: number } }>('/api/control/close-all', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'CLOSE-ALL' }),
    }),
  armLive: (ack: string, walletSecret: string) =>
    request<{ ok: boolean }>('/api/control/arm-live', {
      method: 'POST',
      body: JSON.stringify({ ack, walletSecret }),
    }),
  setProviderKeys: (input: { heliusApiKey?: string; jupiterApiKey?: string; jupiterBaseUrl?: string }) =>
    request<{ ok: boolean; helius: boolean; jupiterKey: boolean }>('/api/settings/keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  disarm: () => request<{ ok: boolean }>('/api/control/disarm', { method: 'POST', body: '{}' }),
  demoStart: () => request<{ ok: boolean }>('/api/demo/start', { method: 'POST', body: '{}' }),
  audit: () => request<{ events: Array<Record<string, unknown>> }>('/api/audit'),
  rejections: () => request<{ rejections: Array<Record<string, unknown>> }>('/api/rejections'),
  candidates: () =>
    request<{ candidates: Array<Record<string, unknown>>; addresses: Array<Record<string, unknown>> }>(
      '/api/candidates',
    ),
  reconciliation: () => request<{ cases: Array<Record<string, unknown>> }>('/api/reconciliation'),
  ops: () =>
    request<{
      operations: import('./types').OpDefinition[];
      current: import('./types').OpRun | null;
      history: import('./types').OpRun[];
      system: import('./types').OpsSystem;
    }>('/api/ops'),
  runOp: (id: string, confirm?: string) =>
    request<{ ok: boolean; run?: import('./types').OpRun }>(`/api/ops/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),
  // D4 watch list actions. Promote is refused with the gate's reason; archive
  // and unarchive only move the membership status.
  watchPromote: (candidateId: string) =>
    request<{ ok: boolean; outcome: string }>('/api/watch/promote', {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
  watchArchive: (candidateId: string) =>
    request<{ ok: boolean }>('/api/watch/archive', {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
  watchUnarchive: (candidateId: string) =>
    request<{ ok: boolean }>('/api/watch/unarchive', {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
  withdrawable: () => request<Record<string, string | boolean | null>>('/api/wallet/withdrawable'),
  withdraw: (asset: 'USDC' | 'SOL', destination: string, amount: string, walletSecret: string) =>
    request<{ ok: boolean; signature: string; amountBase: string; unconfirmed: boolean }>(
      '/api/wallet/withdraw',
      {
        method: 'POST',
        body: JSON.stringify({ asset, destination, amount, walletSecret, confirm: 'SEND' }),
      },
    ),
  createWallet: (secret: string, confirm: string) =>
    request<{ ok: boolean; publicKey: string }>('/api/ops/wallet', {
      method: 'POST',
      body: JSON.stringify({ secret, confirm }),
    }),
};

export type Api = typeof api;
