import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppConfig } from '@zcode-bot/config';
import { LIVE_ACK_STRING } from '@zcode-bot/config';
import { bankrollHeadroom, usdToMicro } from '@zcode-bot/core';
import type { HeliusProvider, JupiterProvider } from '@zcode-bot/providers';
import { checkWalletFilePermissions, walletExists, walletFilePath, walletPublicKey } from '../wallet.js';
import type { ControlService } from './control.js';
import type { LeaderMonitor } from './monitor.js';
import { USDC_MINT } from './engine.js';

export interface ReadinessItem {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
  /** A failed blocker prevents arming/boot restore; a warning is advisory. */
  severity: 'blocker' | 'warning';
}

export interface ReadinessDeps {
  helius: HeliusProvider;
  jupiter: JupiterProvider;
  /** During boot restore the monitor starts after this check. */
  monitorExpected?: boolean;
  /** Raw SQLite integrity check, provided by the runtime. */
  databaseIntegrityOk?: () => boolean;
}

const MIN_SOL_LAMPORTS = 20_000_000; // 0.02 SOL for fees + rent + tip
const CASH_TOLERANCE_USD_MICRO = 1_000_000n; // $1

/**
 * Live arming readiness report. Every blocker is explained and must pass
 * before the arm route mounts the signer. Chain-derived checks run only in
 * live mode so a paper dashboard never spends Helius credits on readiness.
 */
export async function readinessReport(
  db: AppDatabase,
  config: AppConfig,
  control: ControlService,
  monitor: LeaderMonitor | null,
  workerLockHeld: boolean,
  deps?: ReadinessDeps,
): Promise<{ ready: boolean; items: ReadinessItem[] }> {
  const items: ReadinessItem[] = [];
  const env = config.env;
  const live = config.mode === 'live';

  items.push({
    id: 'mode_live',
    ok: live,
    severity: 'blocker',
    label: 'MODE=live configured',
    detail: live ? 'ok' : `current MODE=${config.mode}; live requires MODE=live in .env and a restart`,
  });

  const ack = env.LIVE_TRADING_ACK ?? '';
  items.push({
    id: 'live_ack',
    ok: config.mode !== 'live' || ack === LIVE_ACK_STRING,
    severity: 'blocker',
    label: 'LIVE_TRADING_ACK matches the documented confirmation string',
    detail: ack === LIVE_ACK_STRING ? 'ok' : `LIVE_TRADING_ACK must equal exactly: "${LIVE_ACK_STRING}"`,
  });

  items.push({
    id: 'live_trading',
    ok: env.LIVE_TRADING,
    severity: 'blocker',
    label: 'LIVE_TRADING hard switch is true',
    detail: env.LIVE_TRADING ? 'ok' : 'set LIVE_TRADING=true in .env; false never signs, even in MODE=live',
  });

  const walletPresent = walletExists(env.DATA_DIR, env.WALLET_FILE);
  let walletKey: string | null = null;
  if (walletPresent) {
    try {
      walletKey = walletPublicKey(env.DATA_DIR, env.WALLET_FILE);
    } catch {
      walletKey = null; // unreadable/corrupt file: a blocker, never a crash
    }
  }
  items.push({
    id: 'wallet',
    ok: walletPresent && typeof walletKey === 'string' && walletKey.length > 0,
    severity: 'blocker',
    label: 'Dedicated encrypted wallet exists',
    detail: walletPresent
      ? walletKey !== null
        ? `public key ${walletKey} (only a limited operating balance should fund it)`
        : 'wallet file is unreadable; restore a backup before arming'
      : 'run `pnpm wallet:create` and fund it with a LIMITED amount',
  });

  if (walletPresent) {
    try {
      const perms = checkWalletFilePermissions(walletFilePath(env.DATA_DIR, env.WALLET_FILE));
      items.push({
        id: 'wallet_permissions',
        ok: perms.ok,
        severity: 'warning',
        label: 'Wallet file permissions are restrictive',
        detail: perms.detail,
      });
    } catch {
      items.push({
        id: 'wallet_permissions',
        ok: false,
        severity: 'warning',
        label: 'Wallet file permissions are restrictive',
        detail: 'permission check failed',
      });
    }
  }

  items.push({
    id: 'helius',
    ok: env.HELIUS_API_KEY.trim().length > 0,
    severity: 'blocker',
    label: 'Helius API key configured',
    detail:
      env.HELIUS_API_KEY.trim().length > 0
        ? 'ok'
        : 'set HELIUS_API_KEY in .env (entered locally, never in chat)',
  });

  let jupiterProd = false;
  try {
    const url = new URL(env.JUPITER_BASE_URL);
    jupiterProd =
      url.protocol === 'https:' && url.hostname === 'api.jup.ag' && env.JUPITER_API_KEY.trim().length > 0;
  } catch {
    jupiterProd = false;
  }
  items.push({
    id: 'jupiter',
    ok: jupiterProd,
    severity: 'blocker',
    label: 'Jupiter production endpoint with x-api-key',
    detail: jupiterProd
      ? 'ok'
      : 'live mode requires JUPITER_BASE_URL=https://api.jup.ag and JUPITER_API_KEY from the developers.jup.ag portal',
  });

  items.push({
    id: 'worker',
    ok: Boolean(workerLockHeld && (monitor?.running || deps?.monitorExpected)),
    severity: 'blocker',
    label: 'Single worker running with the exclusive lock',
    detail: workerLockHeld
      ? monitor?.running || deps?.monitorExpected
        ? 'ok'
        : 'monitor not started'
      : 'worker lock not held',
  });

  const openRecon = repo.openReconciliationCases(db, live ? 'live' : 'paper').length;
  items.push({
    id: 'reconciliation',
    ok: openRecon === 0,
    severity: 'blocker',
    label: 'No open reconciliation cases',
    detail: openRecon === 0 ? 'ok' : `${openRecon} case(s) open; resolve via docs/RUNBOOK.md before arming`,
  });

  const pendingIntents = repo.signedIntents(db, live ? 'live' : 'paper').length;
  const pendingWithdrawals = repo.openWithdrawals(db, live ? 'live' : 'paper').length;
  items.push({
    id: 'pending_orders',
    ok: pendingIntents === 0 && pendingWithdrawals === 0,
    severity: 'blocker',
    label: 'No signed/submitted orders or pending withdrawals',
    detail:
      pendingIntents === 0 && pendingWithdrawals === 0
        ? 'ok'
        : `${pendingIntents} signed order(s), ${pendingWithdrawals} pending withdrawal(s)`,
  });

  items.push({
    id: 'emergency',
    ok: !control.flags.emergencyStopped,
    severity: 'blocker',
    label: 'Emergency stop not engaged',
    detail: control.flags.emergencyStopped ? 'clear the emergency stop first' : 'ok',
  });

  const users = repo.countUsers(db);
  items.push({
    id: 'auth',
    ok: users > 0,
    severity: 'blocker',
    label: 'Dashboard user created (setup wizard completed)',
    detail: users > 0 ? 'ok' : 'complete the first-run setup wizard',
  });

  const risk = config.risk;
  const riskOk =
    risk.MIN_PER_BUY_USD > 0 &&
    risk.MAX_PER_BUY_PCT >= 1 &&
    risk.MAX_PER_BUY_PCT <= risk.MAX_OPEN_PER_TRADER_PCT &&
    risk.MAX_OPEN_PER_TRADER_PCT <= 100 &&
    risk.MAX_DEPLOYED_PCT >= 1 &&
    risk.MAX_DEPLOYED_PCT <= 100;
  items.push({
    id: 'risk_sanity',
    ok: riskOk,
    severity: 'blocker',
    label: 'Risk limits are internally consistent',
    detail: riskOk
      ? 'ok'
      : 'MIN_PER_BUY > 0, 1% <= MAX_PER_BUY_PCT <= MAX_OPEN_PER_TRADER_PCT <= 100%, deployment 1-100%',
  });

  if (deps?.databaseIntegrityOk) {
    let integrityOk = false;
    try {
      integrityOk = deps.databaseIntegrityOk();
    } catch {
      integrityOk = false;
    }
    items.push({
      id: 'database',
      ok: integrityOk,
      severity: 'blocker',
      label: 'SQLite integrity check passes',
      detail: integrityOk ? 'ok' : 'PRAGMA quick_check did not return ok',
    });
  }

  // Chain/balance checks only in live mode. A paper dashboard never pays for
  // them; the arm route only runs in live mode.
  if (live) {
    const mode = 'live' as const;
    const pk = walletKey;
    const [solLamports, usdcBase, heliusHealth, jupiterHealth] = await Promise.all([
      pk ? (deps?.helius.solBalanceLamports(pk) ?? Promise.resolve(null)) : Promise.resolve(null),
      pk ? (deps?.helius.tokenBalanceBase(USDC_MINT, pk) ?? Promise.resolve(null)) : Promise.resolve(null),
      deps ? deps.helius.healthCheck() : Promise.resolve({ ok: false, detail: 'not checked' }),
      deps ? deps.jupiter.healthCheck() : Promise.resolve({ ok: false, detail: 'not checked' }),
    ]);

    items.push({
      id: 'helius_health',
      ok: heliusHealth.ok,
      severity: 'blocker',
      label: 'Helius responds to a health probe',
      detail: heliusHealth.ok ? 'ok' : (heliusHealth.detail ?? 'health check failed'),
    });
    items.push({
      id: 'jupiter_health',
      ok: jupiterHealth.ok,
      severity: 'blocker',
      label: 'Jupiter responds to a health probe',
      detail: jupiterHealth.ok ? 'ok' : (jupiterHealth.detail ?? 'health check failed'),
    });

    items.push({
      id: 'wallet_sol',
      ok: solLamports !== null && solLamports >= MIN_SOL_LAMPORTS,
      severity: 'blocker',
      label: 'Wallet has SOL for fees, rent and tips',
      detail:
        solLamports === null
          ? 'SOL balance is unreadable'
          : `${(solLamports / 1e9).toFixed(4)} SOL (need >= ${(MIN_SOL_LAMPORTS / 1e9).toFixed(3)})`,
    });
    items.push({
      id: 'wallet_usdc',
      ok: usdcBase !== null && usdcBase >= BigInt(risk.MIN_PER_BUY_USD) * 1_000_000n,
      severity: 'blocker',
      label: 'Wallet has USDC for the minimum trade',
      detail:
        usdcBase === null
          ? 'USDC balance is unreadable'
          : `${(Number(usdcBase) / 1e6).toFixed(2)} USDC (need >= ${risk.MIN_PER_BUY_USD})`,
    });

    const positions = repo.exposurePositions(db, mode);
    const pendingEntries = repo.pendingEntryIntents(db, mode);
    const unresolvedEntries = repo.unresolvedEntryIntents(db, mode);
    const withdrawals = repo.withdrawalTotals(db, mode);
    const capital =
      BigInt(Math.round(env.EQUITY_START_USD * 1_000_000)) +
      repo.realizedPnlSince(db, '1970-01-01T00:00:00.000Z', mode) -
      withdrawals.sentUsdMicro;
    const deployed =
      positions.reduce(
        (acc, p) => acc + BigInt(p.remainingCostBasisUsdMicro) + BigInt(p.remainingFeesUsdMicro),
        0n,
      ) +
      pendingEntries.reduce((acc, i) => acc + BigInt(i.reservedUsdMicro), 0n) +
      unresolvedEntries.reduce((acc, i) => acc + BigInt(i.inputUsdMicro ?? '0'), 0n);
    const expectedUsdc = capital - deployed;
    const variance =
      expectedUsdc > 0n && (usdcBase ?? 0n) > expectedUsdc
        ? (usdcBase ?? 0n) - expectedUsdc
        : expectedUsdc - (usdcBase ?? 0n);
    const tolerance = CASH_TOLERANCE_USD_MICRO > capital / 200n ? CASH_TOLERANCE_USD_MICRO : capital / 200n;
    items.push({
      id: 'cash_reconciliation',
      ok: usdcBase !== null && expectedUsdc >= 0n && variance <= tolerance,
      severity: 'blocker',
      label: 'On-chain USDC matches the book cash',
      detail:
        usdcBase === null
          ? 'USDC balance is unreadable'
          : `wallet ${(Number(usdcBase) / 1e6).toFixed(2)} vs book ${(Number(expectedUsdc) / 1e6).toFixed(
              2,
            )} (variance ${(Number(variance) / 1e6).toFixed(2)}, tolerance ${(
              Number(tolerance) / 1e6
            ).toFixed(2)}). Fund the wallet to EQUITY_START_USD or adjust the baseline.`,
    });

    if (deps) {
      const chainTime = await deps.helius.chainTime();
      const skew = chainTime === null ? null : Math.abs(Date.now() / 1000 - chainTime);
      items.push({
        id: 'clock',
        ok: skew !== null && skew <= 60,
        severity: 'blocker',
        label: 'Local clock is within 60 seconds of the chain',
        detail: skew === null ? 'chain time is unreadable' : `${Math.round(skew)}s skew`,
      });
    }
  }

  // Advisory: an old backup is a warning, not an arming blocker.
  try {
    const backups = join(env.DATA_DIR, 'backups');
    if (!existsSync(backups)) {
      items.push({
        id: 'backup',
        ok: false,
        severity: 'warning',
        label: 'A recent data backup exists',
        detail: 'no backups directory yet',
      });
    } else {
      const newest = readdirSync(backups)
        .map((name) => {
          try {
            return statSync(join(backups, name)).mtimeMs;
          } catch {
            return 0;
          }
        })
        .reduce((max, t) => (t > max ? t : max), 0);
      const days = newest > 0 ? (Date.now() - newest) / 86_400_000 : Infinity;
      items.push({
        id: 'backup',
        ok: days <= 7,
        severity: 'warning',
        label: 'A recent data backup exists',
        detail: Number.isFinite(days) ? `${days.toFixed(1)} day(s) old` : 'no backup found',
      });
    }
  } catch {
    items.push({
      id: 'backup',
      ok: false,
      severity: 'warning',
      label: 'A recent data backup exists',
      detail: 'backup age could not be read',
    });
  }

  return {
    ready: items.filter((item) => item.severity === 'blocker').every((item) => item.ok),
    items,
  };
}
