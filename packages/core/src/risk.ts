import type { RiskConfig } from '@zcode-bot/config';
import type { MicroUsd } from './money.js';
import { usdToMicro } from './money.js';

export type RiskRule =
  | 'MIN_PER_BUY_USD'
  | 'MAX_PER_BUY_PCT'
  | 'MAX_DEPLOYED_PCT'
  | 'MAX_SLIPPAGE_BPS'
  | 'MAX_PRICE_IMPACT_BPS'
  | 'MAX_COPY_EVENT_AGE_SECONDS'
  | 'LEADERBOARD_MAX_AGE_SECONDS'
  | 'PRICE_MAX_AGE_SECONDS';

export interface RiskCheckInput {
  /** Notional this entry would add, micro-USD (already sized and headroom-capped). */
  entryUsdMicro: MicroUsd;
  /** Effective per-buy cap for this entry: MAX_PER_BUY_PCT of current capital, floored. */
  maxEntryUsdMicro: MicroUsd;
  /** Age of the leader event, seconds. */
  eventAgeSeconds: number;
  /** Age of the price quote used for notional, seconds. */
  priceAgeSeconds: number;
  /** Leaderboard observation age, seconds. Null = not applicable (watch-list hire). */
  leaderboardAgeSeconds: number | null;
  /** Quote slippage in bps (from Jupiter quote), if known. */
  quoteSlippageBps: number | null;
  /** Quote price impact in bps, if known. */
  quotePriceImpactBps: number | null;
}

export type RiskDecision =
  { allowed: true } | { allowed: false; rule: RiskRule; limit: string; value: string; detail: string };

/**
 * Deterministic pre-entry risk gate. Runs before any intent is persisted.
 * Rejections carry machine-readable rule names for the risk_rejections table.
 * Bankroll sizing (max % of capital deployed) is enforced separately, before
 * this gate, via capToHeadroom/bankrollHeadroom.
 */
export function evaluateEntryRisk(config: RiskConfig, input: RiskCheckInput): RiskDecision {
  const min = usdToMicro(config.MIN_PER_BUY_USD);
  const max = input.maxEntryUsdMicro;

  if (input.entryUsdMicro < min) {
    return reject('MIN_PER_BUY_USD', min, input.entryUsdMicro, input, 'sized notional below minimum');
  }
  if (input.entryUsdMicro > max) {
    return reject('MAX_PER_BUY_PCT', max, input.entryUsdMicro, input, 'sized notional above the capital cap');
  }
  if (input.eventAgeSeconds > config.MAX_COPY_EVENT_AGE_SECONDS) {
    return reject(
      'MAX_COPY_EVENT_AGE_SECONDS',
      BigInt(config.MAX_COPY_EVENT_AGE_SECONDS),
      BigInt(input.eventAgeSeconds),
      input,
      'event too old',
    );
  }
  if (input.priceAgeSeconds > config.PRICE_MAX_AGE_SECONDS) {
    return reject(
      'PRICE_MAX_AGE_SECONDS',
      BigInt(config.PRICE_MAX_AGE_SECONDS),
      BigInt(input.priceAgeSeconds),
      input,
      'price stale',
    );
  }
  if (
    input.leaderboardAgeSeconds !== null &&
    input.leaderboardAgeSeconds > config.LEADERBOARD_MAX_AGE_SECONDS
  ) {
    return reject(
      'LEADERBOARD_MAX_AGE_SECONDS',
      BigInt(config.LEADERBOARD_MAX_AGE_SECONDS),
      BigInt(input.leaderboardAgeSeconds),
      input,
      'leaderboard observation stale',
    );
  }
  if (input.quoteSlippageBps !== null && input.quoteSlippageBps > config.MAX_SLIPPAGE_BPS) {
    return reject(
      'MAX_SLIPPAGE_BPS',
      BigInt(config.MAX_SLIPPAGE_BPS),
      BigInt(input.quoteSlippageBps),
      input,
      'quote slippage',
    );
  }
  if (input.quotePriceImpactBps !== null && input.quotePriceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    return reject(
      'MAX_PRICE_IMPACT_BPS',
      BigInt(config.MAX_PRICE_IMPACT_BPS),
      BigInt(input.quotePriceImpactBps),
      input,
      'price impact',
    );
  }
  return { allowed: true };
}

function reject(
  rule: RiskRule,
  limit: bigint,
  value: bigint,
  _input: RiskCheckInput,
  detail: string,
): RiskDecision {
  return { allowed: false, rule, limit: limit.toString(), value: value.toString(), detail };
}

/**
 * Capital-relative exposure cap in micro-USD: `pct`% of current capital, but
 * never below the absolute floor (the per-buy minimum in production). Integer
 * math; a negative or tiny capital falls back to the floor, which the sizing
 * path then treats as the hard minimum.
 */
export function capitalPctCapUsdMicro(
  capitalUsdMicro: MicroUsd,
  pct: number,
  floorUsdMicro: MicroUsd,
): MicroUsd {
  const pctInt = BigInt(Math.max(0, Math.round(pct)));
  const cap = (capitalUsdMicro * pctInt) / 100n;
  return cap > floorUsdMicro ? cap : floorUsdMicro;
}

export interface BankrollInput {
  /** Configured starting equity, micro-USD (EQUITY_START_USD). */
  equityStartUsdMicro: MicroUsd;
  /** Remaining entry cost of open/exposure positions, micro-USD. */
  openEntriesUsdMicro: MicroUsd;
  /** Remaining entry fees of open/exposure positions, micro-USD. */
  openFeesUsdMicro: MicroUsd;
  /** Realized PnL of closed lots, micro-USD (already fee-net). */
  realizedNetUsdMicro: MicroUsd;
  /** Operator ledger changes: +deposits, -successful USDC withdrawals. */
  capitalAdjustmentsUsdMicro?: MicroUsd;
  /** Entry intents still holding budget (pending/signed/unresolved). */
  reservedEntryUsdMicro?: MicroUsd;
  /** Max share of capital allowed in open positions, percent (1-100). */
  maxDeployedPct: number;
}

export interface BankrollState {
  /** equityStart + realized net (fee-net) — the dashboard equity number. */
  capitalUsdMicro: MicroUsd;
  /** capital − deployed (entries incl. fees) — the operator's "bankroll"/cash. */
  cashUsdMicro: MicroUsd;
  /** Deployed amount: open entries + their entry fees. */
  deployedUsdMicro: MicroUsd;
  /** Remaining room under the deployed-% cap; 0 when at/over cap. */
  headroomUsdMicro: MicroUsd;
}

/**
 * Fee-aware bankroll math. Capital grows/shrinks with realized (fee-net) PnL;
 * cash is what would remain after selling nothing — capital minus the entry
 * cost of open positions including their entry fees. Headroom floors: a new
 * bet may use at most (pct% of capital) − deployed.
 */
export function bankrollHeadroom(input: BankrollInput): BankrollState {
  const capital =
    input.equityStartUsdMicro + input.realizedNetUsdMicro + (input.capitalAdjustmentsUsdMicro ?? 0n);
  const deployed = input.openEntriesUsdMicro + input.openFeesUsdMicro + (input.reservedEntryUsdMicro ?? 0n);
  const allowance = (capital * BigInt(Math.round(input.maxDeployedPct))) / 100n;
  const headroom = allowance > deployed ? allowance - deployed : 0n;
  return {
    capitalUsdMicro: capital,
    deployedUsdMicro: deployed,
    cashUsdMicro: capital - deployed,
    headroomUsdMicro: headroom,
  };
}
