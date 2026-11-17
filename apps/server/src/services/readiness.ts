import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppConfig } from '@zcode-bot/config';
import { LIVE_ACK_STRING } from '@zcode-bot/config';
import { walletExists, walletPublicKey } from '../wallet.js';
import type { ControlService } from './control.js';
import type { LeaderMonitor } from './monitor.js';

export interface ReadinessItem {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * Live arming readiness report. Every blocker is explained; live mode is
 * never armed merely because API keys exist.
 */
export function readinessReport(
  db: AppDatabase,
  config: AppConfig,
  control: ControlService,
  monitor: LeaderMonitor | null,
  workerLockHeld: boolean,
): { ready: boolean; items: ReadinessItem[] } {
  const items: ReadinessItem[] = [];
  const env = config.env;

  items.push({
    id: 'mode_live',
    ok: config.mode === 'live',
    label: 'MODE=live configured',
    detail:
      config.mode === 'live'
        ? 'ok'
        : `current MODE=${config.mode}; live requires MODE=live in .env and a restart`,
  });

  const ack = env.LIVE_TRADING_ACK ?? '';
  items.push({
    id: 'live_ack',
    ok: config.mode !== 'live' || ack === LIVE_ACK_STRING,
    label: 'LIVE_TRADING_ACK matches the documented confirmation string',
    detail: ack === LIVE_ACK_STRING ? 'ok' : `LIVE_TRADING_ACK must equal exactly: "${LIVE_ACK_STRING}"`,
  });

  items.push({
    id: 'live_trading',
    ok: env.LIVE_TRADING,
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
    label: 'Dedicated encrypted wallet exists',
    detail: walletPresent
      ? walletKey !== null
        ? `public key ${walletKey} (only a limited operating balance should fund it)`
        : 'wallet file is unreadable; restore a backup before arming'
      : 'run `pnpm wallet:create` and fund it with a LIMITED amount',
  });

  items.push({
    id: 'helius',
    ok: env.HELIUS_API_KEY.trim().length > 0,
    label: 'Helius API key configured',
    detail: env.HELIUS_API_KEY ? 'ok' : 'set HELIUS_API_KEY in .env (entered locally, never in chat)',
  });

  const jupiterProd = env.JUPITER_BASE_URL.includes('api.jup.ag') && env.JUPITER_API_KEY.trim().length > 0;
  items.push({
    id: 'jupiter',
    ok: jupiterProd,
    label: 'Jupiter production endpoint with x-api-key',
    detail: jupiterProd
      ? 'ok'
      : 'live mode requires JUPITER_BASE_URL=https://api.jup.ag and JUPITER_API_KEY from the developers.jup.ag portal',
  });

  items.push({
    id: 'worker',
    ok: Boolean(workerLockHeld && monitor?.running),
    label: 'Single worker running with the exclusive lock',
    detail: workerLockHeld ? (monitor?.running ? 'ok' : 'monitor not started') : 'worker lock not held',
  });

  const openRecon = repo.openReconciliationCases(db).length;
  items.push({
    id: 'reconciliation',
    ok: openRecon === 0,
    label: 'No open reconciliation cases',
    detail: openRecon === 0 ? 'ok' : `${openRecon} case(s) open; resolve via docs/RUNBOOK.md before arming`,
  });

  items.push({
    id: 'emergency',
    ok: !control.flags.emergencyStopped,
    label: 'Emergency stop not engaged',
    detail: control.flags.emergencyStopped ? 'clear the emergency stop first' : 'ok',
  });

  const users = repo.countUsers(db);
  items.push({
    id: 'auth',
    ok: users > 0,
    label: 'Dashboard user created (setup wizard completed)',
    detail: users > 0 ? 'ok' : 'complete the first-run setup wizard',
  });

  return { ready: items.every((i) => i.ok), items };
}
