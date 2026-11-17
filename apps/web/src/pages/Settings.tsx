import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageTabs, TabPanel } from '../components/PageTabs';
import { ConfirmDialog } from '../components/ConfirmDialog';

type SettingsTab = 'controls' | 'risk' | 'imports' | 'keys' | 'live';

interface SettingsView {
  mode: string;
  armed: boolean;
  risk: Record<string, number | string | boolean>;
  paperAssumptions: { slippageBps: number; feeBps: number; note: string };
  providers: {
    heliusConfigured: boolean;
    jupiter: { baseUrl: string; keyConfigured: boolean };
    telegramConfigured: boolean;
    fomoWebConfigured: boolean;
    fomoApiConfigured: boolean;
    fomoApiBaseUrl: string;
  };
  wallet: { exists: boolean; publicKey: string | null };
  readiness: {
    ready: boolean;
    items: Array<{
      id: string;
      ok: boolean;
      label: string;
      detail: string;
      severity?: 'blocker' | 'warning';
    }>;
  };
  control: { newEntriesPaused: boolean; emergencyStopped: boolean };
  liveAckString: string;
}

const EDITABLE_NUMBER_FIELDS = [
  'MIN_PER_BUY_USD',
  'MAX_PER_BUY_USD',
  'MAX_DEPLOYED_PCT',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'IDLE_FIRE_HOURS',
  'MAX_SLIPPAGE_BPS',
  'MAX_PRICE_IMPACT_BPS',
  'MAX_COPY_EVENT_AGE_SECONDS',
  'PRICE_MAX_AGE_SECONDS',
] as const;

/** D4 watch-list / promotion / roster thresholds (safe to tune while running). */
const PIPELINE_NUMBER_FIELDS = [
  'ADMISSION_MIN_BUYS_24H',
  'ADMISSION_MAX_LAST_BUY_HOURS',
  'PROMOTION_MIN_CLOSED',
  'PROMOTION_MIN_NET_USD',
  'PROMOTION_MAX_LAST_BUY_HOURS',
  'WATCH_LIST_SIZE',
  'BENCH_TARGET',
  'ROSTER_SIZE',
  'PER_MINT_CAP_USD',
  'WATCH_POLL_MS',
  'ROSTER_POLL_MS',
  'WATCH_EVICTION_DAYS',
  'DISCOVERY_MIN_INTERVAL_MS',
] as const;

/** Fields where 0 is a legal, meaningful value (not "unset"). */
const ZERO_ALLOWED_FIELDS = new Set<string>(['PER_MINT_CAP_USD']);

const ALL_NUMBER_FIELDS = [...EDITABLE_NUMBER_FIELDS, ...PIPELINE_NUMBER_FIELDS];
type NumberField = (typeof ALL_NUMBER_FIELDS)[number];
/** The boolean field is rendered separately but shares the help map. */
type RiskField = NumberField | 'SHADOW_BACKFILL_ON_ADMIT';

const inputCls =
  'w-full rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-faint';

/**
 * Field help for the risk form. MIN_PER_BUY_USD is a hard floor (D1): every
 * copied buy is at least this, and a leader buy that scales below it is copied
 * at the floor, never skipped.
 */
const RISK_FIELD_HELP: Partial<Record<RiskField, string>> = {
  MIN_PER_BUY_USD:
    'Hard floor: every copied buy is at least this. Leader buys that scale below it are copied at the floor — never skipped.',
  MAX_PER_BUY_USD: 'Ceiling: no copied buy is ever larger than this.',
  PER_MINT_CAP_USD: '0 disables the per-mint cap.',
  SHADOW_BACKFILL_ON_ADMIT: 'Seed each new watch entry from the admission scan (observed trades only).',
};

export function SettingsPage({
  onBack,
  initialTab = 'controls',
  showRisk = true,
  showLive = true,
}: {
  onBack: () => void;
  initialTab?: SettingsTab;
  showRisk?: boolean;
  showLive?: boolean;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [view, setView] = useState<SettingsView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'csv'>('json');
  const [recText, setRecText] = useState('');
  const [armSecret, setArmSecret] = useState('');
  const [armAck, setArmAck] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'emergency' | 'closeAll' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = () => api.settings().then((s) => setView(s as unknown as SettingsView));
  useEffect(() => {
    void load();
  }, []);

  // Risk limits are drafted locally and saved in one explicit commit.
  const [riskDraft, setRiskDraft] = useState<Record<string, string>>({});
  const [backfillDraft, setBackfillDraft] = useState(true);
  useEffect(() => {
    if (view) {
      setRiskDraft(Object.fromEntries(ALL_NUMBER_FIELDS.map((f) => [f, String(view.risk[f] ?? '')])));
      setBackfillDraft(view.risk.SHADOW_BACKFILL_ON_ADMIT !== false);
    }
  }, [view]);

  // Save feedback renders here in the card, next to the button — a top-of-page
  // notice is scrolled out of view exactly when the operator is looking at
  // this form.
  const [riskSave, setRiskSave] = useState<{ busy: boolean; ok: boolean | null; text: string | null }>({
    busy: false,
    ok: null,
    text: null,
  });

  const saveRiskLimits = async () => {
    const current = view?.risk;
    const patch: Record<string, number | boolean> = {};
    for (const f of ALL_NUMBER_FIELDS) {
      const n = Number(riskDraft[f]);
      const zeroAllowed = ZERO_ALLOWED_FIELDS.has(f);
      if (!Number.isFinite(n) || n < 0 || (n === 0 && !zeroAllowed)) {
        setRiskSave({
          busy: false,
          ok: false,
          text: `${f}: must be ${zeroAllowed ? 'zero or a positive number' : 'a positive number'}`,
        });
        return;
      }
      if (f === 'MAX_DEPLOYED_PCT' && n > 100) {
        setRiskSave({ busy: false, ok: false, text: 'MAX_DEPLOYED_PCT: must be 100 or less' });
        return;
      }
      // POSITION_GRACE_HOURS is the one fractional limit (default 1.5). Rounding
      // it to 2 is a risk increase the legacy form has no PIN field for.
      patch[f] = f === 'POSITION_GRACE_HOURS' ? n : Math.round(n);
    }
    patch.SHADOW_BACKFILL_ON_ADMIT = backfillDraft;
    setRiskSave({ busy: true, ok: null, text: null });
    try {
      const r = await api.patchSettings(patch);
      const changed: string[] = current
        ? ALL_NUMBER_FIELDS.filter((f) => Number(r.risk[f]) !== Number(current[f]))
        : [];
      if (current && Boolean(r.risk.SHADOW_BACKFILL_ON_ADMIT) !== backfillDraft) {
        changed.push('SHADOW_BACKFILL_ON_ADMIT');
      }
      const diff =
        changed.length > 0
          ? changed.map((f) => `${f}: ${String(current?.[f])} → ${String(r.risk[f])}`).join(' · ')
          : 'values were already current';
      setRiskSave({
        busy: false,
        ok: true,
        text: `Saved & applied (${diff}). The TRADE screen uses these now — no restart needed.`,
      });
      void load();
    } catch (e) {
      setRiskSave({ busy: false, ok: false, text: (e as Error).message });
    }
  };

  const runControl = (fn: () => Promise<unknown>, message: string) => {
    setActionBusy(true);
    fn()
      .then(() => {
        if (message) setMsg(message);
        setConfirmAction(null);
        void load();
      })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setActionBusy(false));
  };

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between pt-5 pb-3">
        <h1 className="text-[17px] font-bold">Settings</h1>
        <button onClick={onBack} className="label !text-[10.5px] underline cursor-pointer">
          ← dashboard
        </button>
      </div>
      {msg && (
        <p className="text-[12px] mb-3 text-info" role="status">
          {msg}
        </p>
      )}
      {!view && <p className="text-[12px] text-muted">loading…</p>}
      {view && (
        <>
          <PageTabs<SettingsTab>
            label="Settings sections"
            tabs={[
              { id: 'controls', label: 'Controls' },
              ...(showRisk ? [{ id: 'risk' as const, label: 'Risk' }] : []),
              { id: 'imports', label: 'Imports' },
              { id: 'keys', label: 'Keys' },
              ...(showLive ? [{ id: 'live' as const, label: 'Live' }] : []),
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'controls' && (
            <TabPanel>
              <ModeProvidersCard view={view} />
              <section className="card p-4 mb-3.5">
                <p className="label">Controls</p>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {!view.control.newEntriesPaused ? (
                    <button
                      onClick={() =>
                        void api.pause().then(() => {
                          setMsg('new entries paused');
                          void load();
                        })
                      }
                      className="chip border border-warnborder bg-warndim text-warn text-[12px] font-semibold px-4 py-2 cursor-pointer"
                    >
                      Pause new entries
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        void api.resume().then(() => {
                          setMsg('resumed');
                          void load();
                        })
                      }
                      className="chip border border-posborder bg-posdim text-pos text-[12px] font-semibold px-4 py-2 cursor-pointer"
                    >
                      Resume new entries
                    </button>
                  )}
                  {!view.control.emergencyStopped ? (
                    <button
                      onClick={() => setConfirmAction('emergency')}
                      className="chip border border-negborder bg-negdim text-neg mono text-[12px] font-bold px-4 py-2 cursor-pointer"
                    >
                      EMERGENCY STOP
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        void api.emergencyClear().then(() => {
                          setMsg('emergency cleared');
                          void load();
                        })
                      }
                      className="chip border border-negborder bg-transparent text-neg text-[12px] font-semibold px-4 py-2 cursor-pointer"
                    >
                      Clear emergency stop
                    </button>
                  )}
                  <button
                    onClick={() => setConfirmAction('closeAll')}
                    className="chip border border-dangerborder bg-dangerdim text-danger text-[12px] font-semibold px-4 py-2 cursor-pointer"
                  >
                    Close all positions
                  </button>
                </div>
              </section>
              <section className="card p-4">
                <p className="label">Session</p>
                <button
                  onClick={() => void api.logout()}
                  className="mt-2.5 chip border border-glassborder bg-inset text-muted text-[12px] font-semibold px-4 py-2 cursor-pointer hover:text-ink"
                >
                  Sign out
                </button>
              </section>
            </TabPanel>
          )}

          {tab === 'risk' && (
            <TabPanel>
              <section className="card p-4 mb-3.5">
                <p className="label">Risk limits</p>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {EDITABLE_NUMBER_FIELDS.map((f) => (
                    <label key={f} className="mono text-[9.5px] text-faint">
                      {f}
                      <input
                        type="number"
                        data-testid={`risk-${f}`}
                        value={riskDraft[f] ?? ''}
                        onChange={(e) => setRiskDraft((d) => ({ ...d, [f]: e.target.value }))}
                        className={`mt-1 ${inputCls}`}
                      />
                      {RISK_FIELD_HELP[f] && (
                        <span
                          data-testid={`risk-help-${f}`}
                          className="mt-1 block font-sans text-[10px] leading-relaxed text-muted"
                        >
                          {RISK_FIELD_HELP[f]}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <p className="label !text-[9.5px] !text-faint mt-3">
                  These are the D4 watch-list / bench / roster thresholds: who enters the watch list, when a
                  wallet joins the bench (the ordered queue a freed chair is filled from), and how often each
                  side is polled. Milliseconds are milliseconds; 0 in PER_MINT_CAP_USD disables the cap.
                </p>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {PIPELINE_NUMBER_FIELDS.map((f) => (
                    <label key={f} className="mono text-[9.5px] text-faint">
                      {f}
                      <input
                        type="number"
                        data-testid={`risk-${f}`}
                        value={riskDraft[f] ?? ''}
                        onChange={(e) => setRiskDraft((d) => ({ ...d, [f]: e.target.value }))}
                        className={`mt-1 ${inputCls}`}
                      />
                      {RISK_FIELD_HELP[f] && (
                        <span
                          data-testid={`risk-help-${f}`}
                          className="mt-1 block font-sans text-[10px] leading-relaxed text-muted"
                        >
                          {RISK_FIELD_HELP[f]}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <label className="mt-3 flex items-start gap-2 mono text-[9.5px] text-faint">
                  <input
                    type="checkbox"
                    data-testid="risk-SHADOW_BACKFILL_ON_ADMIT"
                    checked={backfillDraft}
                    onChange={(e) => setBackfillDraft(e.target.checked)}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span>
                    SHADOW_BACKFILL_ON_ADMIT
                    <span className="mt-0.5 block font-sans text-[10px] leading-relaxed text-muted">
                      {RISK_FIELD_HELP.SHADOW_BACKFILL_ON_ADMIT}
                    </span>
                  </span>
                </label>
                <button
                  onClick={() => void saveRiskLimits()}
                  disabled={riskSave.busy}
                  data-testid="save-risk"
                  className="mt-3 w-full rounded-[12px] bg-accentdim border border-accentborder text-accent mono text-[12px] font-bold px-4 py-2.5 disabled:opacity-40 cursor-pointer"
                >
                  {riskSave.busy ? 'SAVING…' : 'SAVE RISK LIMITS'}
                </button>
                {riskSave.text && (
                  <div
                    data-testid="save-risk-status"
                    role="status"
                    className={`mt-2 panel p-3 ${riskSave.ok ? 'border-posborder bg-posdim' : 'border-negborder bg-negdim'}`}
                  >
                    <p className={`label !text-[10px] font-bold ${riskSave.ok ? '!text-pos' : '!text-neg'}`}>
                      {riskSave.busy ? 'SAVING…' : riskSave.ok ? '✓ SAVED & APPLIED' : '✗ NOT SAVED'}
                    </p>
                    <p className="text-[11.5px] text-muted mt-1">{riskSave.text}</p>
                  </div>
                )}
                <p className="label !text-[9.5px] !text-faint mt-3">
                  Saved settings survive restarts · copy_scale {String(view.risk.COPY_SCALE)} ·
                  loss_streak_unit {String(view.risk.LOSS_STREAK_UNIT)} · fire_position_policy{' '}
                  {String(view.risk.FIRE_POSITION_POLICY)}
                </p>
              </section>
            </TabPanel>
          )}

          {tab === 'imports' && (
            <TabPanel>
              <section className="card p-4 mb-3.5">
                <p className="label">Manual FOMO leaderboard import (fallback only)</p>
                <p className="text-[11px] text-muted mt-1">
                  The automatic inlet is the fomoapi leaderboard (D3). Use this paste-in only when it is
                  unavailable: paste JSON or CSV (see fixtures/leaderboard.example.*). Validation, duplicate
                  handling, and audit are applied server-side.
                </p>
                <div className="flex gap-2 mt-2">
                  {(['json', 'csv'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setImportFormat(f)}
                      className={`label !text-[10px] chip border cursor-pointer ${
                        importFormat === f
                          ? 'bg-accentdim text-accent border-accentborder'
                          : 'bg-inset text-muted border-insetborder'
                      }`}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={5}
                  className="w-full mt-2 rounded-[12px] border border-glassborder bg-inset p-3 text-[11px] mono text-ink placeholder:text-faint"
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
                    } catch (e) {
                      setMsg(`import failed: ${(e as Error).message}`);
                    }
                  }}
                  className="mt-2 rounded-[12px] bg-accentdim border border-accentborder text-accent text-[12px] font-semibold px-4 py-2 cursor-pointer"
                >
                  Import candidates
                </button>
              </section>
            </TabPanel>
          )}

          {tab === 'keys' && (
            <TabPanel>
              <ProviderKeysCard
                heliusConfigured={view.providers.heliusConfigured}
                jupiterKeyConfigured={view.providers.jupiter.keyConfigured}
                jupiterBaseUrl={view.providers.jupiter.baseUrl}
                fomoApiConfigured={view.providers.fomoApiConfigured}
                fomoApiBaseUrl={view.providers.fomoApiBaseUrl}
                onSaved={(m) => {
                  setMsg(m);
                  void load();
                }}
              />
            </TabPanel>
          )}

          {tab === 'live' && (
            <TabPanel>
              <LiveCard
                view={view}
                armSecret={armSecret}
                setArmSecret={setArmSecret}
                armAck={armAck}
                setArmAck={setArmAck}
                onMsg={setMsg}
                onReload={() => void load()}
              />
            </TabPanel>
          )}
        </>
      )}

      {confirmAction === 'emergency' && (
        <ConfirmDialog
          title="EMERGENCY STOP"
          dangerLabel="BLOCKS ALL NEW ENTRIES"
          body="Blocks all new entries and non-risk-reducing signing. Already-submitted transactions cannot be recalled. Type STOP to proceed."
          requiredWord="STOP"
          confirmLabel="ENGAGE"
          busy={actionBusy}
          onConfirm={() => runControl(() => api.emergencyStop(), 'EMERGENCY STOP engaged')}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'closeAll' && (
        <ConfirmDialog
          title="Close all positions"
          dangerLabel="MIRRORS EXITS ON EVERY OPEN POSITION"
          body="Closes all open copied positions now by mirroring exits. Type CLOSE-ALL to proceed."
          requiredWord="CLOSE-ALL"
          confirmLabel="CLOSE ALL"
          busy={actionBusy}
          onConfirm={() =>
            runControl(async () => {
              const r = await api.closeAll();
              setMsg(`close-all: ${JSON.stringify(r.result ?? r)}`);
            }, '')
          }
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

function ModeProvidersCard({ view }: { view: SettingsView }) {
  return (
    <section className="card p-4 mb-3.5">
      <p className="label">Mode & providers</p>
      <ul className="mt-2 text-[12px] space-y-1">
        <li>
          Mode: <strong>{view.mode.toUpperCase()}</strong>
          {view.mode === 'live' ? ' (arming required separately)' : ''}
        </li>
        <li>
          Helius:{' '}
          <strong className={view.providers.heliusConfigured ? 'text-pos' : 'text-neg'}>
            {view.providers.heliusConfigured ? 'configured' : 'not configured'}
          </strong>
        </li>
        <li>
          Jupiter: {view.providers.jupiter.baseUrl} · key{' '}
          {view.providers.jupiter.keyConfigured ? 'configured' : 'not set (free lite tier)'}
        </li>
        <li>Telegram notifications: {view.providers.telegramConfigured ? 'on' : 'off'}</li>
        <li data-testid="provider-fomoapi-summary">
          fomoapi discovery ({view.providers.fomoApiBaseUrl}):{' '}
          <strong className={view.providers.fomoApiConfigured ? 'text-pos' : 'text-neg'}>
            {view.providers.fomoApiConfigured ? 'configured' : 'not configured'}
          </strong>
        </li>
        <li>
          FOMO web capture (fallback):{' '}
          {view.providers.fomoWebConfigured ? 'configured' : 'manual import only'}
        </li>
        <li className="break-all">
          Wallet:{' '}
          <span className="mono text-[11px]">
            {view.wallet.exists ? view.wallet.publicKey : 'none — run `pnpm wallet:create` locally'}
          </span>
        </li>
      </ul>
      <p className="label !text-[9.5px] !text-faint mt-3">
        Paper assumptions · {view.paperAssumptions.slippageBps} bps slippage · {view.paperAssumptions.feeBps}{' '}
        bps fees · nothing is ever signed
      </p>
    </section>
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
  fomoApiConfigured,
  fomoApiBaseUrl,
  onSaved,
}: {
  heliusConfigured: boolean;
  jupiterKeyConfigured: boolean;
  jupiterBaseUrl: string;
  fomoApiConfigured: boolean;
  fomoApiBaseUrl: string;
  onSaved: (message: string) => void;
}) {
  const [heliusKey, setHeliusKey] = useState('');
  const [jupKey, setJupKey] = useState('');
  const [jupUrl, setJupUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chip = (ok: boolean) => (
    <span className={`tag chip ${ok ? 'bg-posdim text-pos' : 'bg-negdim text-neg'}`}>
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
    <section className="card p-4 mb-3.5" aria-label="provider keys">
      <p className="label">Provider keys</p>
      <p className="text-[11px] text-muted mt-1">
        Paste keys once — they are stored on this PC (.env) and applied immediately. Write-only: stored values
        are never shown again, so keep your own copy. Get a free Helius key at dashboard.helius.dev.
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <p className="label !text-[9.5px] w-16 shrink-0">HELIUS</p>
          {chip(heliusConfigured)}
        </div>
        <input
          type="password"
          value={heliusKey}
          onChange={(e) => setHeliusKey(e.target.value)}
          placeholder={heliusConfigured ? 'replace Helius key (optional)' : 'paste Helius API key'}
          className={inputCls}
          autoComplete="off"
        />
        <div className="flex items-center gap-2">
          <p className="label !text-[9.5px] w-16 shrink-0">JUPITER</p>
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
          className={inputCls}
          autoComplete="off"
        />
        <input
          value={jupUrl}
          onChange={(e) => setJupUrl(e.target.value)}
          placeholder={`Jupiter URL (current: ${jupiterBaseUrl})`}
          className={inputCls}
          autoComplete="off"
        />
      </div>
      {error && <p className="text-[12px] text-neg mt-2">{error}</p>}
      <button
        disabled={busy}
        onClick={save}
        className="mt-3 rounded-[12px] bg-accentdim border border-accentborder text-accent text-[12px] font-semibold px-4 py-2 disabled:opacity-40 cursor-pointer"
      >
        {busy ? 'Saving…' : 'Save keys'}
      </button>
      <div className="flex items-center gap-2 mt-3 border-t border-insetborder pt-3">
        <p className="label !text-[9.5px] w-16 shrink-0">FOMOAPI</p>
        <span data-testid="provider-fomoapi" className="text-[11px] text-muted">
          discovery inlet ({fomoApiBaseUrl}):{' '}
          <strong className={fomoApiConfigured ? 'text-pos' : 'text-neg'}>
            {fomoApiConfigured ? 'configured' : 'not configured'}
          </strong>
        </span>
      </div>
      <p className="label !text-[9.5px] !text-faint mt-1">
        FOMOAPI_KEY is read from .env only — set it there and restart; it is never entered or shown here.
      </p>
    </section>
  );
}

function LiveCard({
  view,
  armSecret,
  setArmSecret,
  armAck,
  setArmAck,
  onMsg,
  onReload,
}: {
  view: SettingsView;
  armSecret: string;
  setArmSecret: (v: string) => void;
  armAck: boolean;
  setArmAck: (v: boolean) => void;
  onMsg: (m: string) => void;
  onReload: () => void;
}) {
  return (
    <section className="card p-4" aria-label="live readiness">
      <p className="label">Live readiness & arming</p>
      <ul className="mt-2 text-[12px] space-y-1.5">
        {view.readiness.items.map((item) => (
          <li key={item.id} className="flex gap-2">
            <span aria-label={item.ok ? 'ok' : item.severity === 'warning' ? 'warning' : 'blocked'}>
              {item.ok ? '✅' : item.severity === 'warning' ? '⚠️' : '⛔'}
            </span>
            <span>
              <strong>{item.label}</strong>
              <br />
              <span className="text-faint text-[11px]">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {view.mode === 'live' && (
        <div className="mt-3 border-t border-insetborder pt-3">
          {view.armed ? (
            <div className="panel border-posborder bg-posdim p-3" data-testid="armed-box">
              <p className="tag !text-pos font-bold">🟢 LIVE ARMED — REAL TRADES ARE SIGNING</p>
              <p className="text-[11.5px] text-muted mt-1">
                Every copied trade signs with your wallet. DISARM stops new entries; open positions can still
                be exited until the wallet is locked. EMERGENCY STOP also blocks new entries immediately.
              </p>
              <button
                onClick={() =>
                  void api
                    .disarm()
                    .then(() => onMsg('disarmed — live signing stopped'))
                    .catch((e) => onMsg((e as Error).message))
                }
                className="mt-2 chip border border-warnborder bg-warndim text-warn text-[12px] font-semibold px-4 py-2 cursor-pointer"
              >
                DISARM
              </button>
            </div>
          ) : (
            <>
              <label className="label flex items-center gap-2 !text-[10.5px]">
                <input
                  type="checkbox"
                  checked={armAck}
                  onChange={(e) => setArmAck(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                I acknowledge: “{view.liveAckString}”
              </label>
              <input
                type="password"
                value={armSecret}
                onChange={(e) => setArmSecret(e.target.value)}
                placeholder="wallet encryption secret (used in-memory only)"
                className={`${inputCls} mt-2`}
              />
              <button
                disabled={!armAck || !armSecret}
                onClick={() =>
                  void api
                    .armLive(view.liveAckString, armSecret)
                    .then(() => {
                      setArmSecret('');
                      setArmAck(false);
                      onMsg('LIVE ARMED — real signing is on');
                      onReload();
                    })
                    .catch((e) => onMsg((e as Error).message))
                }
                className="mt-2 rounded-[12px] bg-negdim border border-negborder text-neg mono text-[12px] font-bold px-4 py-2 disabled:opacity-40 cursor-pointer"
              >
                ARM LIVE
              </button>
              <button
                onClick={() =>
                  void api
                    .lockWallet()
                    .then(() => {
                      onMsg('wallet locked — no signing until re-armed');
                      onReload();
                    })
                    .catch((e) => onMsg((e as Error).message))
                }
                className="mt-2 ml-2 chip border border-insetborder bg-panel text-muted text-[12px] font-semibold px-3 py-2 cursor-pointer"
                title="Only allowed when no live positions or reconciliation cases remain"
              >
                LOCK WALLET
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
