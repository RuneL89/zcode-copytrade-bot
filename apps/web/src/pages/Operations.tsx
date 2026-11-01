import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { OpDefinition, OpRun, OpsSystem } from '../types';
import { clockFromSeconds } from '../types';
import { PageTabs, TabPanel } from '../components/PageTabs';

type OpsTab = 'status' | 'commands' | 'wallet' | 'history';

/**
 * Operations console, tabbed: Status (system + live terminal), Commands
 * (whitelisted ops), Wallet (setup + withdrawals), History. Every op id and
 * confirmation word is server-defined; the client sends only those two fields.
 */
export function OperationsPage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<OpsTab>('status');
  const [ops, setOps] = useState<OpDefinition[]>([]);
  const [current, setCurrent] = useState<OpRun | null>(null);
  const [history, setHistory] = useState<OpRun[]>([]);
  const [system, setSystem] = useState<OpsSystem | null>(null);
  const [confirmOp, setConfirmOp] = useState<OpDefinition | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await api.ops();
      setOps(data.operations);
      setCurrent(data.current);
      setHistory(data.history);
      setSystem(data.system);
    } catch (e) {
      setLastError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  // Poll while anything is running so output streams live.
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [current, load]);

  const run = async (op: OpDefinition) => {
    setLastError(null);
    if (op.danger !== 'normal') {
      setConfirmOp(op);
      return;
    }
    try {
      await api.runOp(op.id);
      setReloadTick((t) => t + 1);
      void load();
    } catch (e) {
      setLastError((e as Error).message);
    }
  };

  const groups: Array<{ id: OpDefinition['group']; title: string }> = [
    { id: 'setup', title: 'Setup & build' },
    { id: 'server', title: 'Server' },
    { id: 'testing', title: 'Testing' },
    { id: 'maintenance', title: 'Maintenance' },
  ];
  const grouped = useMemo(() => {
    const map = new Map<OpDefinition['group'], OpDefinition[]>();
    for (const op of ops) {
      const list = map.get(op.group) ?? [];
      list.push(op);
      map.set(op.group, list);
    }
    return map;
  }, [ops]);

  const busy = current !== null;

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between pt-5 pb-3">
        <div>
          <h1 className="text-[17px] font-bold">Operations</h1>
          <p className="label !text-[10px] !text-faint mt-0.5">No-terminal control center</p>
        </div>
        <button onClick={onBack} className="label !text-[10.5px] underline cursor-pointer">
          ← dashboard
        </button>
      </div>

      {lastError && (
        <div className="card !bg-negdim !border-negborder p-3 mb-3.5 text-[12px] text-neg" role="alert">
          {lastError}
        </div>
      )}

      <PageTabs<OpsTab>
        label="Operations sections"
        tabs={[
          { id: 'status', label: 'Status' },
          { id: 'commands', label: 'Commands' },
          { id: 'wallet', label: 'Wallet' },
          { id: 'history', label: 'History' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'status' && (
        <TabPanel>
          <section className="card p-4 mb-3.5" aria-label="system status" data-testid="ops-status">
            {system ? (
              <div className="grid grid-cols-3 gap-x-3 gap-y-3">
                <Stat label="Mode" value={system.mode.toUpperCase()} />
                <Stat label="Node" value={system.nodeVersion.replace('v', '')} />
                <Stat label="Uptime" value={clockFromSeconds(system.uptimeSeconds)} />
                <Stat
                  label="Worker"
                  value={system.workerRunning ? 'RUNNING' : 'STOPPED'}
                  tone={system.workerRunning ? 'pos' : 'neg'}
                />
                <Stat label="DB" value={`${(system.dbBytes / 1024).toFixed(0)} KB`} />
                <Stat
                  label="Wallet"
                  value={system.walletExists ? 'READY' : 'NONE'}
                  tone={system.walletExists ? 'pos' : undefined}
                />
              </div>
            ) : (
              <p className="text-[12px] text-muted">loading status…</p>
            )}
            {system && (
              <p className="mono text-[9px] text-faint mt-3 break-all">
                DATA {system.dataDir} · BACKUPS {system.backups.length}
              </p>
            )}
          </section>
          <TerminalPane current={current} />
        </TabPanel>
      )}

      {tab === 'commands' && (
        <TabPanel>
          {groups.map((g) => {
            const list = grouped.get(g.id) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={g.id} className="card p-4 mb-3.5" aria-label={g.title.toLowerCase()}>
                <p className="label">{g.title}</p>
                <ul className="mt-1.5 divide-y divide-insetborder">
                  {list.map((op) => (
                    <li key={op.id} className="flex items-center gap-3 py-2.5" data-testid={`op-${op.id}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold">{op.label}</p>
                        <p className="text-[11px] text-muted">{op.description}</p>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => void run(op)}
                        className={`shrink-0 rounded-[10px] mono text-[11px] font-semibold px-3 py-1.5 transition-colors disabled:opacity-40 cursor-pointer ${
                          op.danger === 'destructive'
                            ? 'border border-negborder bg-negdim text-neg hover:bg-negdim/70'
                            : op.danger === 'confirm'
                              ? 'border border-warnborder bg-warndim text-warn hover:bg-warndim/70'
                              : 'border border-accentborder bg-accentdim text-accent hover:bg-accentdim/70'
                        }`}
                      >
                        {busy && current?.opId === op.id
                          ? 'RUNNING…'
                          : op.danger === 'destructive'
                            ? 'RESET…'
                            : 'RUN'}
                      </button>
                    </li>
                  ))}
                </ul>
                {busy && (
                  <p className="label !text-[9.5px] !text-warn mt-2">
                    an operation is running — others are queued out
                  </p>
                )}
              </section>
            );
          })}
        </TabPanel>
      )}

      {tab === 'wallet' && (
        <TabPanel>
          <WalletCard
            onDone={() => setReloadTick((t) => t + 1)}
            walletExists={system?.walletExists ?? false}
          />
          <WithdrawCard
            walletExists={system?.walletExists ?? false}
            onDone={() => setReloadTick((t) => t + 1)}
          />
        </TabPanel>
      )}

      {tab === 'history' && (
        <TabPanel>
          <section className="card p-4" aria-label="operation history">
            <p className="label">Recent operations</p>
            {history.length === 0 && <p className="text-[12px] text-muted mt-2">nothing run yet</p>}
            <ul className="mt-2 text-[12px] space-y-1.5">
              {history.slice(0, 10).map((h) => (
                <li key={h.runId} className="flex items-center gap-2 border-b border-insetborder pb-1.5">
                  <span
                    aria-label={h.status}
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      h.status === 'succeeded'
                        ? 'bg-pos'
                        : h.status === 'running'
                          ? 'bg-info live-dot'
                          : h.status === 'timeout'
                            ? 'bg-warn'
                            : 'bg-neg'
                    }`}
                  />
                  <span className="flex-1 truncate">
                    {h.label}
                    {h.summary ? <span className="text-faint"> — {h.summary}</span> : null}
                  </span>
                  <span className="money label !text-[9.5px] shrink-0">{durationOf(h)}</span>
                </li>
              ))}
            </ul>
          </section>
        </TabPanel>
      )}

      {confirmOp && (
        <ConfirmModal
          op={confirmOp}
          busy={busy}
          onCancel={() => setConfirmOp(null)}
          onConfirm={async (word) => {
            try {
              await api.runOp(confirmOp.id, word);
              setConfirmOp(null);
              setReloadTick((t) => t + 1);
              void load();
            } catch (e) {
              setLastError((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div>
      <p className="label !text-[9.5px]">{label}</p>
      <p
        className={`money text-[13px] font-semibold ${tone === 'pos' ? 'text-pos' : tone === 'neg' ? 'text-neg' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}

function durationOf(run: OpRun): string {
  if (!run.endedAt) return '…';
  const ms = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

function TerminalPane({ current }: { current: OpRun | null }) {
  const boxRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current?.lines.length]);

  return (
    <section className="card p-4" aria-label="operation output" data-testid="ops-terminal">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Output {current ? `· ${current.label}` : ''}</p>
        {current ? (
          <span className="tag chip bg-infodim text-info live-dot">RUNNING</span>
        ) : (
          <span className="tag text-faint">IDLE</span>
        )}
      </div>
      <pre
        ref={boxRef}
        className="mono mt-2 rounded-[12px] bg-page-elev border border-insetborder text-[#c9cede] text-[10.5px] leading-[1.55] p-3 h-44 overflow-auto whitespace-pre-wrap break-all"
        data-testid="ops-output"
      >
        {current && current.lines.length > 0
          ? current.lines.join('\n')
          : current
            ? 'starting…'
            : 'Idle. Output of every operation appears here.'}
      </pre>
      {current && (
        <p className="label !text-[9.5px] !text-faint mt-1.5">
          {current.lines.length} lines · started {new Date(current.startedAt).toLocaleTimeString()}
        </p>
      )}
    </section>
  );
}

interface Withdrawable {
  hasWallet: boolean;
  publicKey: string | null;
  solLamports: string | null;
  usdcBase: string | null;
  cashUsdMicro: string;
  withdrawableSolBase: string;
  withdrawableUsdcBase: string;
  solReserveLamports: string;
}

const LAMPORTS = 1_000_000_000n;

function baseToDecimal(base: string | null, decimals: number, maxDp = 6): string {
  if (base === null) return '—';
  const n = BigInt(base);
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const frac = (n % scale).toString().padStart(decimals, '0').slice(0, maxDp).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

function WithdrawCard({ walletExists, onDone }: { walletExists: boolean; onDone: () => void }) {
  const [info, setInfo] = useState<Withdrawable | null>(null);
  const [asset, setAsset] = useState<'USDC' | 'SOL'>('USDC');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [secret, setSecret] = useState('');
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ signature: string; unconfirmed: boolean } | null>(null);

  const loadInfo = () => {
    void api
      .withdrawable()
      .then((r) => setInfo(r as unknown as Withdrawable))
      .catch(() => setInfo(null));
  };
  useEffect(() => {
    if (walletExists) loadInfo();
  }, [walletExists]);

  if (!walletExists) {
    return (
      <section className="card p-4 mb-3.5" aria-label="withdraw funds" data-testid="withdraw-card">
        <p className="label">Withdraw funds</p>
        <p className="text-[12px] text-muted mt-1">
          Create the encrypted wallet first — withdrawals send from it on Solana.
        </p>
      </section>
    );
  }

  const cap = asset === 'USDC' ? (info?.withdrawableUsdcBase ?? '0') : (info?.withdrawableSolBase ?? '0');
  const capText = asset === 'USDC' ? `${baseToDecimal(cap, 6, 2)} USDC` : `${baseToDecimal(cap, 9, 4)} SOL`;
  const ready =
    amount.trim() !== '' && destination.trim() !== '' && secret.length >= 16 && word.trim() === 'SEND';

  const submit = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    api
      .withdraw(asset, destination.trim(), amount.trim(), secret)
      .then((r) => {
        setResult({ signature: r.signature, unconfirmed: r.unconfirmed });
        setSecret('');
        setWord('');
        setAmount('');
        loadInfo();
        onDone();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card p-4 mb-3.5" aria-label="withdraw funds" data-testid="withdraw-card">
      <div className="flex items-center justify-between">
        <p className="label">Withdraw funds</p>
        <button onClick={loadInfo} className="label !text-[10px] underline cursor-pointer">
          refresh
        </button>
      </div>
      <p className="text-[11px] text-muted mt-1">
        Sends from the bot wallet on Solana. Only the free bankroll is withdrawable — money in open positions
        stays put, and {info ? baseToDecimal(info.solReserveLamports, 9, 3) : '0.005'} SOL is kept for network
        fees. The encryption secret is used in memory only.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="panel px-3 py-2">
          <p className="label !text-[9px]">Available USDC (bankroll)</p>
          <p className="money text-[13px] font-bold">
            {info ? baseToDecimal(info.withdrawableUsdcBase, 6, 2) : '…'}
          </p>
        </div>
        <div className="panel px-3 py-2">
          <p className="label !text-[9px]">Available SOL (fee reserve kept)</p>
          <p className="money text-[13px] font-bold">
            {info ? baseToDecimal(info.withdrawableSolBase, 9, 4) : '…'}
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        {(['USDC', 'SOL'] as const).map((a) => (
          <button
            key={a}
            onClick={() => {
              setAsset(a);
              setAmount('');
            }}
            className={`label !text-[10px] chip border cursor-pointer ${
              asset === a
                ? 'bg-accentdim text-accent border-accentborder'
                : 'bg-inset text-muted border-insetborder'
            }`}
          >
            {a}
          </button>
        ))}
        <button
          onClick={() => {
            const scale = asset === 'USDC' ? 1_000_000n : LAMPORTS;
            const n = BigInt(cap);
            const whole = n / scale;
            const frac = (n % scale).toString().padStart(asset === 'USDC' ? 6 : 9, '0');
            setAmount(asset === 'USDC' ? `${whole}.${frac.slice(0, 6)}` : `${whole}.${frac}`);
          }}
          className="label !text-[10px] chip border border-warnborder bg-warndim text-warn ml-auto cursor-pointer"
        >
          MAX ({capText})
        </button>
      </div>

      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={`amount in ${asset}`}
        className="w-full mt-2 rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-faint"
      />
      <input
        type="text"
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="destination Solana address"
        spellCheck={false}
        autoComplete="off"
        className="w-full mt-2 rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[11px] mono break-all text-ink placeholder:text-faint"
      />
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="wallet encryption secret (in-memory only)"
        autoComplete="off"
        className="w-full mt-2 rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-faint"
      />
      <input
        type="text"
        value={word}
        onChange={(e) => setWord(e.target.value)}
        placeholder="type SEND to confirm"
        autoComplete="off"
        className="w-full mt-2 rounded-[12px] border border-warnborder bg-warndim px-3 py-2 text-[12px] text-ink placeholder:text-warn/70"
      />

      <button
        onClick={submit}
        disabled={!ready || busy}
        className="mt-3 w-full rounded-[12px] bg-negdim border border-negborder text-neg mono text-[12px] font-bold px-4 py-2.5 disabled:opacity-40 cursor-pointer"
      >
        {busy ? 'Sending…' : `SEND ${asset}`}
      </button>

      {error && (
        <p className="text-[12px] text-neg mt-2" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div
          className={`mt-2 panel p-3 ${result.unconfirmed ? 'border-warnborder bg-warndim' : 'border-posborder bg-posdim'}`}
        >
          <p className={`label !text-[9.5px] font-bold ${result.unconfirmed ? '!text-warn' : '!text-pos'}`}>
            {result.unconfirmed ? 'SUBMITTED — UNCONFIRMED, VERIFY ON CHAIN (DO NOT RETRY)' : 'SENT'}
          </p>
          <a
            href={`https://solscan.io/tx/${result.signature}`}
            target="_blank"
            rel="noreferrer"
            className="mono text-[10px] break-all underline text-ink"
          >
            {result.signature}
          </a>
        </div>
      )}
    </section>
  );
}

function WalletCard({ onDone, walletExists }: { onDone: () => void; walletExists: boolean }) {
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (walletExists) {
    return (
      <section className="card p-4 mb-3.5" aria-label="wallet setup">
        <p className="label">Wallet setup</p>
        <p className="text-[12px] text-muted mt-1">
          A dedicated encrypted wallet exists. Public key and backup guidance are in Settings; backups go
          through Maintenance → Back up data now.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4 mb-3.5" aria-label="wallet setup">
      <p className="label">Wallet setup · create encrypted wallet</p>
      <p className="text-[11px] text-muted mt-1">
        Creates the dedicated Solana hot wallet locally (AES-256-GCM). The encryption secret is used for this
        request only — never stored, logged, or shown again. Losing it means losing the wallet.
      </p>
      <div className="grid grid-cols-1 gap-2 mt-2">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="encryption secret (min 16 chars)"
          className="rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-faint"
          minLength={16}
          autoComplete="new-password"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="repeat the secret"
          className="rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-faint"
          autoComplete="new-password"
        />
      </div>
      {msg && <p className="text-[12px] text-info mt-2">{msg}</p>}
      <button
        disabled={busy || secret.length < 16 || secret !== confirm}
        onClick={() => {
          setBusy(true);
          setMsg(null);
          api
            .createWallet(secret, confirm)
            .then((r) => {
              setMsg(`wallet created: ${r.publicKey}`);
              setSecret('');
              setConfirm('');
              onDone();
            })
            .catch((e) => setMsg((e as Error).message))
            .finally(() => setBusy(false));
        }}
        className="mt-3 rounded-[12px] bg-accentdim border border-accentborder text-accent mono text-[12px] font-semibold px-4 py-2 disabled:opacity-40 cursor-pointer"
      >
        {busy ? 'Creating…' : 'Create wallet'}
      </button>
    </section>
  );
}

function ConfirmModal({
  op,
  busy,
  onCancel,
  onConfirm,
}: {
  op: OpDefinition;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (word: string) => Promise<void>;
}) {
  const [word, setWord] = useState('');
  const required = op.danger === 'destructive' ? (op.confirmWord ?? 'RESET') : 'RUN';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const destructive = op.danger === 'destructive';
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 anim-scrim"
      style={{ background: 'rgba(4, 5, 8, 0.7)', backdropFilter: 'blur(5px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`confirm ${op.label}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card !bg-glassstrong p-5 w-full max-w-[400px] anim-raise">
        <p className={`tag ${destructive ? '!text-neg' : '!text-warn'}`}>
          {destructive ? 'DESTRUCTIVE OPERATION' : 'CONFIRMATION REQUIRED'}
        </p>
        <p className="text-[15px] font-bold mt-1">{op.label}</p>
        <p className="text-[12px] text-muted mt-1.5">{op.description}</p>
        {destructive && (
          <p className="text-[12px] text-neg mt-2">
            This deletes the database: all positions, fills, audit events, and the dashboard user. Back up
            first (Maintenance → Back up data now). Type “{required}” to proceed.
          </p>
        )}
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder={`type ${required}`}
          className="w-full mt-3 rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[13px] mono text-ink placeholder:text-faint"
          autoFocus
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 rounded-[12px] border border-glassborder bg-inset text-[12px] font-semibold py-2 text-ink cursor-pointer"
          >
            Cancel
          </button>
          <button
            disabled={busy || word.trim() !== required}
            onClick={() => void onConfirm(word.trim())}
            className={`flex-1 rounded-[12px] mono text-[12px] font-bold py-2 disabled:opacity-40 cursor-pointer ${
              destructive
                ? 'bg-negdim border border-negborder text-neg'
                : 'bg-accentdim border border-accentborder text-accent'
            }`}
          >
            {busy ? 'Running…' : destructive ? 'Yes, do it' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
