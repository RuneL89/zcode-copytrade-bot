import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { OpDefinition, OpRun, OpsSystem } from '../types';
import { clockFromSeconds } from '../types';

/**
 * Operations console: every install/maintenance command, runnable without a
 * terminal. Compact operational density (admin surface): status first, action
 * cards grouped by subsystem, one terminal working panel, history secondary.
 */
export function OperationsPage({ onBack }: { onBack: () => void }) {
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
    { id: 'setup', title: 'SETUP & BUILD' },
    { id: 'server', title: 'SERVER' },
    { id: 'testing', title: 'TESTING' },
    { id: 'maintenance', title: 'MAINTENANCE' },
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
          <h1 className="text-[18px] font-bold">Operations</h1>
          <p className="label !text-[9px] mt-0.5">NO-TERMINAL CONTROL CENTER</p>
        </div>
        <button onClick={onBack} className="label !text-[10px] underline">
          ← dashboard
        </button>
      </div>

      {lastError && (
        <div className="card !bg-rose-50/80 border-rose-200 p-3 mb-4 text-[12px] text-rose-700" role="alert">
          {lastError}
        </div>
      )}

      {/* status strip */}
      <section className="card p-4 mb-4" aria-label="system status" data-testid="ops-status">
        {system ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Stat label="MODE" value={system.mode.toUpperCase()} />
            <Stat label="NODE" value={system.nodeVersion.replace('v', '')} />
            <Stat label="UPTIME" value={clockFromSeconds(system.uptimeSeconds)} />
            <Stat
              label="WORKER"
              value={system.workerRunning ? 'RUNNING' : 'STOPPED'}
              tone={system.workerRunning ? 'pos' : 'neg'}
            />
            <Stat label="DB" value={`${(system.dbBytes / 1024).toFixed(0)} KB`} />
            <Stat
              label="WALLET"
              value={system.walletExists ? 'READY' : 'NONE'}
              tone={system.walletExists ? 'pos' : undefined}
            />
          </div>
        ) : (
          <p className="text-[12px] text-[#7d78a0]">loading status…</p>
        )}
        {system && (
          <p className="label !text-[8.5px] mt-3 break-all">
            DATA {system.dataDir} · BACKUPS {system.backups.length}
          </p>
        )}
      </section>

      {/* terminal working panel */}
      <TerminalPane current={current} />

      {/* action groups */}
      {groups.map((g) => {
        const list = grouped.get(g.id) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={g.id} className="card p-4 mb-4" aria-label={g.title.toLowerCase()}>
            <p className="label">{g.title}</p>
            <ul className="mt-2 divide-y divide-white/70">
              {list.map((op) => (
                <li key={op.id} className="flex items-center gap-3 py-2.5" data-testid={`op-${op.id}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold">{op.label}</p>
                    <p className="text-[11px] text-[#7d78a0]">{op.description}</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void run(op)}
                    className={`shrink-0 rounded-xl text-[12px] font-semibold px-3.5 py-2 transition-colors disabled:opacity-40 ${
                      op.danger === 'destructive'
                        ? 'border border-rose-400 bg-rose-50 text-rose-700 hover:bg-rose-100'
                        : op.danger === 'confirm'
                          ? 'border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100'
                          : 'border border-white bg-white/80 text-[#2a2740] hover:bg-white'
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
              <p className="label !text-[8.5px] mt-2 text-orange-700">
                an operation is running — others are queued out
              </p>
            )}
          </section>
        );
      })}

      {/* wallet setup */}
      <WalletCard onDone={() => setReloadTick((t) => t + 1)} walletExists={system?.walletExists ?? false} />

      {/* withdrawals */}
      <WithdrawCard walletExists={system?.walletExists ?? false} onDone={() => setReloadTick((t) => t + 1)} />

      {/* history */}
      <section className="card p-4" aria-label="operation history">
        <p className="label">RECENT OPERATIONS</p>
        {history.length === 0 && <p className="text-[12px] text-[#7d78a0] mt-2">nothing run yet</p>}
        <ul className="mt-2 text-[12px] space-y-1.5">
          {history.slice(0, 10).map((h) => (
            <li key={h.runId} className="flex items-center gap-2 border-b border-white/60 pb-1.5">
              <span
                aria-label={h.status}
                className={`w-2 h-2 rounded-full shrink-0 ${
                  h.status === 'succeeded'
                    ? 'bg-emerald-500'
                    : h.status === 'running'
                      ? 'bg-indigo-400 live-dot'
                      : h.status === 'timeout'
                        ? 'bg-orange-400'
                        : 'bg-rose-500'
                }`}
              />
              <span className="flex-1 truncate">
                {h.label}
                {h.summary ? <span className="text-[#7d78a0]"> — {h.summary}</span> : null}
              </span>
              <span className="money label !text-[9px] shrink-0">{durationOf(h)}</span>
            </li>
          ))}
        </ul>
      </section>

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
      <p className="label !text-[8.5px]">{label}</p>
      <p
        className="money text-[13px] font-semibold"
        style={{ color: tone === 'pos' ? '#16a06a' : tone === 'neg' ? '#e85454' : undefined }}
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
    <section className="card p-4 mb-4" aria-label="operation output" data-testid="ops-terminal">
      <div className="flex items-center justify-between gap-2">
        <p className="label">OUTPUT {current ? `· ${current.label.toUpperCase()}` : ''}</p>
        {current ? (
          <span className="label !text-[9px] rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5 live-dot">
            RUNNING
          </span>
        ) : (
          <span className="label !text-[9px] text-[#c6c2dd]">IDLE</span>
        )}
      </div>
      <pre
        ref={boxRef}
        className="mt-2 rounded-[14px] bg-[#211e33] text-[#d6d2ee] text-[10.5px] leading-[1.5] font-mono p-3 h-44 overflow-auto whitespace-pre-wrap break-all"
        data-testid="ops-output"
      >
        {current && current.lines.length > 0
          ? current.lines.join('\n')
          : current
            ? 'starting…'
            : 'Idle. Output of every operation appears here.'}
      </pre>
      {current && (
        <p className="label !text-[8.5px] mt-1.5">
          {current.lines.length} LINES · STARTED {new Date(current.startedAt).toLocaleTimeString()}
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
  const [msg, setMsg] = useState<string | null>(null);
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
      <section className="card p-4 mb-4" aria-label="withdraw funds" data-testid="withdraw-card">
        <p className="label">WITHDRAW FUNDS</p>
        <p className="text-[12px] text-[#7d78a0] mt-1">
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
    setMsg(null);
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
    <section className="card p-4 mb-4" aria-label="withdraw funds" data-testid="withdraw-card">
      <div className="flex items-center justify-between">
        <p className="label">WITHDRAW FUNDS</p>
        <button onClick={loadInfo} className="label !text-[9px] underline">
          refresh
        </button>
      </div>
      <p className="text-[11px] text-[#7d78a0] mt-1">
        Sends from the bot wallet on Solana. Only the free bankroll is withdrawable — money in open positions
        stays put, and {info ? baseToDecimal(info.solReserveLamports, 9, 3) : '0.005'} SOL is kept for network
        fees. The encryption secret is used in memory only.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white/70 border border-white px-3 py-2">
          <p className="label !text-[8px]">AVAILABLE USDC (BANKROLL)</p>
          <p className="money text-[13px] font-bold">
            {info ? baseToDecimal(info.withdrawableUsdcBase, 6, 2) : '…'}
          </p>
        </div>
        <div className="rounded-xl bg-white/70 border border-white px-3 py-2">
          <p className="label !text-[8px]">AVAILABLE SOL (FEE RESERVE KEPT)</p>
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
            className={`label !text-[10px] rounded-full px-3 py-1.5 border ${
              asset === a
                ? 'bg-[#2a2740] text-white border-[#2a2740]'
                : 'bg-white/70 text-[#7d78a0] border-white'
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
          className="label !text-[10px] rounded-full px-3 py-1.5 border border-orange-200 bg-orange-50 text-orange-700 ml-auto"
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
        className="w-full mt-2 rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
      />
      <input
        type="text"
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="destination Solana address"
        spellCheck={false}
        autoComplete="off"
        className="w-full mt-2 rounded-xl border border-white bg-white/70 px-3 py-2 text-[11px] font-mono break-all"
      />
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="wallet encryption secret (in-memory only)"
        autoComplete="off"
        className="w-full mt-2 rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
      />
      <input
        type="text"
        value={word}
        onChange={(e) => setWord(e.target.value)}
        placeholder="type SEND to confirm"
        autoComplete="off"
        className="w-full mt-2 rounded-xl border border-orange-200 bg-orange-50/60 px-3 py-2 text-[12px]"
      />

      <button
        onClick={submit}
        disabled={!ready || busy}
        className="mt-3 w-full rounded-xl bg-rose-600 text-white text-[12px] font-bold px-4 py-2.5 disabled:opacity-40"
      >
        {busy ? 'Sending…' : `SEND ${asset}`}
      </button>

      {error && (
        <p className="text-[12px] text-rose-600 mt-2" role="alert">
          {error}
        </p>
      )}
      {msg && <p className="text-[12px] text-indigo-700 mt-2">{msg}</p>}
      {result && (
        <div
          className={`mt-2 rounded-xl border p-3 ${
            result.unconfirmed ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-200'
          }`}
        >
          <p
            className={`label !text-[9px] font-bold ${result.unconfirmed ? 'text-amber-800' : 'text-emerald-700'}`}
          >
            {result.unconfirmed ? 'SUBMITTED — UNCONFIRMED, VERIFY ON CHAIN (DO NOT RETRY)' : 'SENT'}
          </p>
          <a
            href={`https://solscan.io/tx/${result.signature}`}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-mono break-all underline text-[#2a2740]"
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
      <section className="card p-4 mb-4" aria-label="wallet setup">
        <p className="label">WALLET SETUP</p>
        <p className="text-[12px] text-[#7d78a0] mt-1">
          A dedicated encrypted wallet exists. Public key and backup guidance are in Settings; backups go
          through Maintenance → Back up data now.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4 mb-4" aria-label="wallet setup">
      <p className="label">WALLET SETUP · CREATE ENCRYPTED WALLET</p>
      <p className="text-[11px] text-[#7d78a0] mt-1">
        Creates the dedicated Solana hot wallet locally (AES-256-GCM). The encryption secret is used for this
        request only — never stored, logged, or shown again. Losing it means losing the wallet.
      </p>
      <div className="grid grid-cols-1 gap-2 mt-2">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="encryption secret (min 16 chars)"
          className="rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
          minLength={16}
          autoComplete="new-password"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="repeat the secret"
          className="rounded-xl border border-white bg-white/70 px-3 py-2 text-[12px]"
          autoComplete="new-password"
        />
      </div>
      {msg && <p className="text-[12px] text-indigo-700 mt-2">{msg}</p>}
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
        className="mt-3 rounded-xl bg-[#2a2740] text-white text-[12px] font-semibold px-4 py-2 disabled:opacity-40"
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
      style={{ background: 'rgba(24, 20, 44, 0.45)', backdropFilter: 'blur(3px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`confirm ${op.label}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card !bg-white/90 p-5 w-full max-w-[400px] anim-raise">
        <p className={`label ${destructive ? '!text-rose-600' : '!text-orange-600'}`}>
          {destructive ? 'DESTRUCTIVE OPERATION' : 'CONFIRMATION REQUIRED'}
        </p>
        <p className="text-[15px] font-bold mt-1">{op.label}</p>
        <p className="text-[12px] text-[#7d78a0] mt-1.5">{op.description}</p>
        {destructive && (
          <p className="text-[12px] text-rose-700 mt-2">
            This deletes the database: all positions, fills, audit events, and the dashboard user. Back up
            first (Maintenance → Back up data now). Type “{required}” to proceed.
          </p>
        )}
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder={`type ${required}`}
          className="w-full mt-3 rounded-xl border border-white bg-white/80 px-3 py-2 text-[13px] font-mono"
          autoFocus
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-white bg-white/70 text-[12px] font-semibold py-2"
          >
            Cancel
          </button>
          <button
            disabled={busy || word.trim() !== required}
            onClick={() => void onConfirm(word.trim())}
            className={`flex-1 rounded-xl text-white text-[12px] font-bold py-2 disabled:opacity-40 ${
              destructive ? 'bg-rose-600' : 'bg-[#2a2740]'
            }`}
          >
            {busy ? 'Running…' : destructive ? 'Yes, do it' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
