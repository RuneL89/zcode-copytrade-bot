import { useEffect, useState } from 'react';
import { api } from '../api';

interface SettingsView {
  mode: string;
  armed: boolean;
  risk: Record<string, number | string>;
  paperAssumptions: { slippageBps: number; feeBps: number; note: string };
  providers: {
    heliusConfigured: boolean;
    jupiter: { baseUrl: string; keyConfigured: boolean };
    telegramConfigured: boolean;
    fomoWebConfigured: boolean;
  };
  wallet: { exists: boolean; publicKey: string | null };
  snapshot: { snapshotId: string; hash: string; createdAt: string; candidates: number } | null;
  readiness: { ready: boolean; items: Array<{ id: string; ok: boolean; label: string; detail: string }> };
  control: { newEntriesPaused: boolean; emergencyStopped: boolean };
  liveAckString: string;
}

const EDITABLE_NUMBER_FIELDS = [
  'MIN_PER_BUY_USD',
  'MAX_PER_BUY_USD',
  'MAX_DEPLOYED_PCT',
  'MAX_DAILY_REALIZED_LOSS_USD',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'IDLE_FIRE_HOURS',
  'MAX_SLIPPAGE_BPS',
  'MAX_PRICE_IMPACT_BPS',
  'MAX_COPY_EVENT_AGE_SECONDS',
  'PRICE_MAX_AGE_SECONDS',
] as const;

export function SettingsPage({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'csv'>('json');
  const [recText, setRecText] = useState('');
  const [armSecret, setArmSecret] = useState('');
  const [armAck, setArmAck] = useState(false);

  const load = () => api.settings().then((s) => setView(s as unknown as SettingsView));
  useEffect(() => {
    void load();
  }, []);

  // Risk limits are drafted locally and saved in one explicit commit.
  const [riskDraft, setRiskDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (view) {
      setRiskDraft(Object.fromEntries(EDITABLE_NUMBER_FIELDS.map((f) => [f, String(view.risk[f] ?? '')])));
    }
  }, [view]);

  const saveRiskLimits = async () => {
    const patch: Record<string, number> = {};
    for (const f of EDITABLE_NUMBER_FIELDS) {
      const n = Number(riskDraft[f]);
      if (!Number.isFinite(n) || n <= 0) return setMsg(`${f}: must be a positive number`);
      if (f === 'MAX_DEPLOYED_PCT' && n > 100) return setMsg('MAX_DEPLOYED_PCT: must be 100 or less');
      patch[f] = Math.round(n);
    }
    try {
      await api.patchSettings(patch);
      setMsg('Risk limits saved — they now survive restarts');
      onChanged();
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between pt-5 pb-3">
        <h1 className="text-[18px] font-bold">Settings</h1>
        <button onClick={onBack} className="label !text-[10px] underline">
          ← dashboard
        </button>
      </div>
      {msg && <p className="text-[12px] mb-3 text-indigo-700">{msg}</p>}
      {!view && <p className="text-[12px] text-[#7d78a0]">loading…</p>}
      {view && (
        <>
          {/* Mode + provider status */}
          <section className="card p-5 mb-4">
            <p className="label">MODE &amp; PROVIDERS</p>
            <ul className="mt-2 text-[12px] space-y-1">
              <li>
                MODE: <strong>{view.mode.toUpperCase()}</strong>
                {view.mode === 'live' ? ' (arming required separately)' : ''}
              </li>
              <li>
                Helius:{' '}
                <strong style={{ color: view.providers.heliusConfigured ? '#16a06a' : '#e85454' }}>
                  {view.providers.heliusConfigured ? 'configured' : 'not configured'}
                </strong>
              </li>
              <li>
                Jupiter: {view.providers.jupiter.baseUrl} · key{' '}
                {view.providers.jupiter.keyConfigured ? 'configured' : 'not set (free lite tier)'}
              </li>
              <li>Telegram notifications: {view.providers.telegramConfigured ? 'on' : 'off'}</li>
              <li>
                FOMO web discovery: {view.providers.fomoWebConfigured ? 'configured' : 'manual import only'}
              </li>
              <li>
                Wallet:{' '}
                {view.wallet.exists ? view.wallet.publicKey : 'none — run `pnpm wallet:create` locally'}
              </li>
            </ul>
            <p className="label !text-[8.5px] mt-3">
              PAPER ASSUMPTIONS · {view.paperAssumptions.slippageBps} bps slippage ·{' '}
              {view.paperAssumptions.feeBps} bps fees · nothing is ever signed
            </p>
          </section>

          {/* Provider keys (write-only) */}
          <ProviderKeysCard
            heliusConfigured={view.providers.heliusConfigured}
            jupiterKeyConfigured={view.providers.jupiter.keyConfigured}
            jupiterBaseUrl={view.providers.jupiter.baseUrl}
            onSaved={(m) => {
              setMsg(m);
              void load();
              onChanged();
            }}
          />

          {/* Manual leaderboard import */}
          <section className="card p-5 mb-4">
            <p className="label">MANUAL FOMO LEADERBOARD IMPORT</p>
            <p className="text-[11px] text-[#7d78a0] mt-1">
              Paste JSON or CSV (see fixtures/leaderboard.example.*). Validation, duplicate handling, and
              audit are applied server-side.
            </p>
            <div className="flex gap-2 mt-2">
              {(['json', 'csv'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setImportFormat(f)}
                  className={`label !text-[9px] rounded-full px-3 py-1 border ${importFormat === f ? 'bg-[#2a2740] text-white border-[#2a2740]' : 'border-white bg-white/60'}`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={5}
              className="w-full mt-2 rounded-xl border border-white bg-white/70 p-3 text-[11px] font-mono"
              placeholder={
                importFormat === 'json'
                  ? '[{"handle":"ape_vasco","weeklyRank":1,...}]'
                  : 'handle,weekly_rank,...'
              }
            />
            <button
              onClick={async () => {
                try {
                  const r = await api.importLeaderboard(importFormat, importText);
                  setMsg(
                    `import ok: ${r.entries} entries${r.warnings.length ? ` · warnings: ${r.warnings.slice(0, 2).join('; ')}` : ''}`,
                  );
                  onChanged();
                } catch (e) {
                  setMsg(`import failed: ${(e as Error).message}`);
                }
              }}
              className="mt-2 rounded-xl bg-[#2a2740] text-white text-[12px] font-semibold px-4 py-2"
            >
              Import candidates
            </button>
          </section>

          {/* Recommendation import (JSON-file fallback) */}
          <section className="card p-5 mb-4">
            <p className="label">ZCODE RECOMMENDATION (JSON IMPORT FALLBACK)</p>
            <p className="text-[11px] text-[#7d78a0] mt-1">
              Same validation as the MCP submission path. Requires a CURRENT snapshot (id + sha256) — see
              docs/ZCODE_AUTOMATION.md.
            </p>
            <textarea
              value={recText}
              onChange={(e) => setRecText(e.target.value)}
              rows={4}
              className="w-full mt-2 rounded-xl border border-white bg-white/70 p-3 text-[11px] font-mono"
              placeholder='{"schemaVersion":1,"recommendationId":"…","snapshotId":"…",…}'
            />
            <button
              onClick={async () => {
                try {
                  const payload = JSON.parse(recText);
                  const r = await api.importRecommendation(payload);
                  setMsg(r.ok ? 'recommendation accepted' : `rejected: ${r.code}`);
                  onChanged();
                  void load();
                } catch (e) {
                  setMsg(`invalid JSON or submission failed: ${(e as Error).message}`);
                }
              }}
              className="mt-2 rounded-xl bg-[#2a2740] text-white text-[12px] font-semibold px-4 py-2"
            >
              Submit recommendation
            </button>
            {view.snapshot && (
              <p className="label !text-[8.5px] mt-2 break-all">
                CURRENT SNAPSHOT {view.snapshot.snapshotId} · {view.snapshot.candidates} candidates · hash{' '}
                {view.snapshot.hash.slice(0, 16)}… · {view.snapshot.createdAt}
              </p>
            )}
          </section>

          {/* Risk limits */}
          <section className="card p-5 mb-4">
            <p className="label">RISK LIMITS</p>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {EDITABLE_NUMBER_FIELDS.map((f) => (
                <label key={f} className="text-[10px] font-mono text-[#7d78a0]">
                  {f}
                  <input
                    type="number"
                    value={riskDraft[f] ?? ''}
                    onChange={(e) => setRiskDraft((d) => ({ ...d, [f]: e.target.value }))}
                    className="w-full mt-1 rounded-lg border border-white bg-white/70 px-2 py-1.5 text-[12px] text-[#2a2740]"
                  />
                </label>
              ))}
            </div>
            <button
              onClick={() => void saveRiskLimits()}
              data-testid="save-risk"
              className="mt-3 w-full rounded-xl bg-[#2a2740] text-white text-[12px] font-bold px-4 py-2.5 disabled:opacity-40"
            >
              SAVE RISK LIMITS
            </button>
            <p className="label !text-[8.5px] mt-3">
              SAVED SETTINGS SURVIVE RESTARTS · COPY_SCALE {String(view.risk.COPY_SCALE)} · LOSS_STREAK_UNIT{' '}
              {String(view.risk.LOSS_STREAK_UNIT)} · FIRE_POSITION_POLICY{' '}
              {String(view.risk.FIRE_POSITION_POLICY)} · CANDIDATE_REPLACEMENT_MODE{' '}
              {String(view.risk.CANDIDATE_REPLACEMENT_MODE)}
            </p>
          </section>

          {/* Controls */}
          <section className="card p-5 mb-4">
            <p className="label">CONTROLS</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {!view.control.newEntriesPaused ? (
                <button
                  onClick={() =>
                    void api.pause().then(() => {
                      setMsg('new entries paused');
                      void load();
                      onChanged();
                    })
                  }
                  className="rounded-xl border border-orange-300 bg-orange-50 text-orange-700 text-[12px] font-semibold px-4 py-2"
                >
                  Pause new entries
                </button>
              ) : (
                <button
                  onClick={() =>
                    void api.resume().then(() => {
                      setMsg('resumed');
                      void load();
                      onChanged();
                    })
                  }
                  className="rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-700 text-[12px] font-semibold px-4 py-2"
                >
                  Resume new entries
                </button>
              )}
              {!view.control.emergencyStopped ? (
                <button
                  onClick={() => {
                    if (
                      confirm(
                        'EMERGENCY STOP: block all new entries and non-risk-reducing signing? Already-submitted transactions cannot be recalled.',
                      )
                    ) {
                      void api.emergencyStop().then(() => {
                        setMsg('EMERGENCY STOP engaged');
                        void load();
                        onChanged();
                      });
                    }
                  }}
                  className="rounded-xl border border-rose-400 bg-rose-50 text-rose-700 text-[12px] font-bold px-4 py-2"
                >
                  EMERGENCY STOP
                </button>
              ) : (
                <button
                  onClick={() =>
                    void api.emergencyClear().then(() => {
                      setMsg('emergency cleared');
                      void load();
                      onChanged();
                    })
                  }
                  className="rounded-xl border border-rose-300 bg-white text-rose-700 text-[12px] font-semibold px-4 py-2"
                >
                  Clear emergency stop
                </button>
              )}
              <button
                onClick={() => {
                  if (
                    confirm('CLOSE ALL open copied positions now? This is separately confirmed for safety.')
                  ) {
                    void api
                      .closeAll()
                      .then((r) => setMsg(`close-all: ${JSON.stringify(r.result ?? r)}`))
                      .catch((e) => setMsg((e as Error).message));
                  }
                }}
                className="rounded-xl border border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700 text-[12px] font-semibold px-4 py-2"
              >
                Close all positions
              </button>
            </div>
          </section>

          {/* Live readiness */}
          <section className="card p-5">
            <p className="label">LIVE READINESS &amp; ARMING</p>
            <ul className="mt-2 text-[12px] space-y-1.5">
              {view.readiness.items.map((item) => (
                <li key={item.id} className="flex gap-2">
                  <span aria-label={item.ok ? 'ok' : 'blocked'}>{item.ok ? '✅' : '⛔'}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <br />
                    <span className="text-[#7d78a0] text-[11px]">{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {view.mode === 'live' && (
              <div className="mt-3 border-t border-white/70 pt-3">
                {view.armed ? (
                  <div
                    className="rounded-xl bg-emerald-50 border border-emerald-200 p-3"
                    data-testid="armed-box"
                  >
                    <p className="label !text-[10px] text-emerald-700 font-bold">
                      🟢 LIVE ARMED — REAL TRADES ARE SIGNING
                    </p>
                    <p className="text-[11.5px] text-[#7d78a0] mt-1">
                      Every copied trade signs with your wallet. Use DISARM to stop signing, or EMERGENCY STOP
                      above to also block new entries.
                    </p>
                    <button
                      onClick={() =>
                        void api
                          .disarm()
                          .then(() => setMsg('disarmed — live signing stopped'))
                          .catch((e) => setMsg((e as Error).message))
                      }
                      className="mt-2 rounded-xl border border-orange-300 bg-orange-50 text-orange-700 text-[12px] font-semibold px-4 py-2"
                    >
                      DISARM
                    </button>
                  </div>
                ) : (
                  <>
                    <label className="label flex items-center gap-2 !text-[10px]">
                      <input type="checkbox" checked={armAck} onChange={(e) => setArmAck(e.target.checked)} />
                      I ACKNOWLEDGE: “{view.liveAckString}”
                    </label>
                    <input
                      type="password"
                      value={armSecret}
                      onChange={(e) => setArmSecret(e.target.value)}
                      placeholder="wallet encryption secret (used in-memory only)"
                      className="w-full mt-2 rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
                    />
                    <button
                      disabled={!armAck || !armSecret}
                      onClick={() =>
                        void api
                          .armLive(view.liveAckString, armSecret)
                          .then(() => {
                            setArmSecret('');
                            setArmAck(false);
                            setMsg('LIVE ARMED — real signing is on');
                            void load();
                          })
                          .catch((e) => setMsg((e as Error).message))
                      }
                      className="mt-2 rounded-xl bg-rose-600 text-white text-[12px] font-bold px-4 py-2 disabled:opacity-40"
                    >
                      ARM LIVE
                    </button>
                  </>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Write-only provider credentials. Fields are never prefilled and stored
 * values are never returned by the API — the inputs stay empty and the only
 * feedback is the configured/not-configured status chips.
 */
function ProviderKeysCard({
  heliusConfigured,
  jupiterKeyConfigured,
  jupiterBaseUrl,
  onSaved,
}: {
  heliusConfigured: boolean;
  jupiterKeyConfigured: boolean;
  jupiterBaseUrl: string;
  onSaved: (message: string) => void;
}) {
  const [heliusKey, setHeliusKey] = useState('');
  const [jupKey, setJupKey] = useState('');
  const [jupUrl, setJupUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chip = (ok: boolean) => (
    <span
      className="label !text-[9px] rounded-full px-2 py-0.5"
      style={ok ? { background: '#d8f3e6', color: '#0d7a4e' } : { background: '#fde8e8', color: '#c03c3c' }}
    >
      {ok ? 'CONFIGURED' : 'NOT SET'}
    </span>
  );

  const save = () => {
    setBusy(true);
    setError(null);
    const input: { heliusApiKey?: string; jupiterApiKey?: string; jupiterBaseUrl?: string } = {};
    if (heliusKey.trim()) input.heliusApiKey = heliusKey.trim();
    if (jupKey.trim()) input.jupiterApiKey = jupKey.trim();
    if (jupUrl.trim() && jupUrl.trim() !== jupiterBaseUrl) input.jupiterBaseUrl = jupUrl.trim();
    if (Object.keys(input).length === 0) {
      setBusy(false);
      setError('Paste at least one key first.');
      return;
    }
    api
      .setProviderKeys(input)
      .then((r) => {
        setHeliusKey('');
        setJupKey('');
        setJupUrl('');
        let m = `Keys saved${r.helius ? ' · Helius active' : ''}${r.jupiterKey ? ' · Jupiter key active' : ''}. Applied immediately, no restart needed.`;
        const check = (r as { heliusCheck?: { ok: boolean; detail: string } | null }).heliusCheck;
        if (check?.ok) m = 'Helius key active — connection verified ✓ (RPC reachable).';
        else if (check && !check.ok)
          m = `Key saved, but the connection test failed: ${check.detail}. Double-check that you copied the whole key.`;
        onSaved(m);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card p-5 mb-4" aria-label="provider keys">
      <p className="label">PROVIDER KEYS</p>
      <p className="text-[11px] text-[#7d78a0] mt-1">
        Paste keys once — they are stored on this PC (.env) and applied immediately. Write-only: stored values
        are never shown again, so keep your own copy. Get a free Helius key at dashboard.helius.dev.
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <p className="label !text-[9px] w-20 shrink-0">HELIUS</p>
          {chip(heliusConfigured)}
        </div>
        <input
          type="password"
          value={heliusKey}
          onChange={(e) => setHeliusKey(e.target.value)}
          placeholder={heliusConfigured ? 'replace Helius key (optional)' : 'paste Helius API key'}
          className="w-full rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
          autoComplete="off"
        />
        <div className="flex items-center gap-2">
          <p className="label !text-[9px] w-20 shrink-0">JUPITER</p>
          {chip(jupiterKeyConfigured)}
        </div>
        <input
          type="password"
          value={jupKey}
          onChange={(e) => setJupKey(e.target.value)}
          placeholder={
            jupiterKeyConfigured
              ? 'replace Jupiter key (optional)'
              : 'Jupiter API key (optional — free tier works without)'
          }
          className="w-full rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
          autoComplete="off"
        />
        <input
          value={jupUrl}
          onChange={(e) => setJupUrl(e.target.value)}
          placeholder={`Jupiter URL (current: ${jupiterBaseUrl})`}
          className="w-full rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
          autoComplete="off"
        />
      </div>
      {error && <p className="text-[12px] text-rose-600 mt-2">{error}</p>}
      <button
        disabled={busy}
        onClick={save}
        className="mt-3 rounded-xl bg-[#2a2740] text-white text-[12px] font-semibold px-4 py-2 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save keys'}
      </button>
    </section>
  );
}
