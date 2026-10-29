import type { MicroUsd } from './money.js';

/**
 * Withdrawal rules: money can only leave the wallet from the FREE bankroll —
 * never funds attributed to open positions — and the SOL fee reserve must
 * survive so the bot can still sign and pay network fees.
 *
 * Pure and deterministic: address validity is an input so this module needs no
 * chain access (the server validates base58/32-byte addresses with web3.js).
 */

export type WithdrawAsset = 'USDC' | 'SOL';

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
/** 0.005 SOL kept back for transaction fees. */
export const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;

export type WithdrawErrorCode =
  'AMOUNT_INVALID' | 'INSUFFICIENT_AVAILABLE' | 'DESTINATION_INVALID' | 'DESTINATION_IS_SELF';

export interface WithdrawPlan {
  ok: boolean;
  code?: WithdrawErrorCode;
  detail?: string;
}

/**
 * Parse a human decimal amount ("12", "12.5", "0.005") into base units for the
 * asset's decimals. Rejects anything that is not a plain positive decimal:
 * negatives, exponents, commas, empty strings, and surplus decimal places
 * (so a USDC amount can never silently lose a digit to truncation).
 */
export function parseAmountToBase(
  input: string,
  decimals: number,
): { ok: true; base: bigint } | { ok: false; code: 'AMOUNT_INVALID'; detail: string } {
  const s = (input ?? '').trim();
  if (!s) return { ok: false, code: 'AMOUNT_INVALID', detail: 'amount is required' };
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { ok: false, code: 'AMOUNT_INVALID', detail: 'use a plain positive decimal like 12.5' };
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    return {
      ok: false,
      code: 'AMOUNT_INVALID',
      detail: `at most ${decimals} decimal places for this asset`,
    };
  }
  const base = BigInt((whole ?? '0') + frac.padEnd(decimals, '0'));
  if (base <= 0n) return { ok: false, code: 'AMOUNT_INVALID', detail: 'amount must be greater than 0' };
  return { ok: true, base };
}

/**
 * How much may be withdrawn right now.
 * - SOL: on-chain balance minus the fee reserve (never negative).
 * - USDC: min(on-chain balance, free cash). Free cash is capital − deployed
 *   (open positions' entry cost incl. fees); negative cash clamps to 0.
 */
export function withdrawableBase(input: {
  asset: WithdrawAsset;
  onchainBase: MicroUsd;
  cashUsdMicro: MicroUsd;
  solReserveLamports?: bigint;
}): bigint {
  const onchain = input.onchainBase > 0n ? input.onchainBase : 0n;
  if (input.asset === 'SOL') {
    const reserve = input.solReserveLamports ?? SOL_FEE_RESERVE_LAMPORTS;
    return onchain > reserve ? onchain - reserve : 0n;
  }
  const cash = input.cashUsdMicro > 0n ? input.cashUsdMicro : 0n;
  return onchain < cash ? onchain : cash;
}

export interface WithdrawPlanInput {
  asset: WithdrawAsset;
  amountBase: MicroUsd;
  withdrawableBase: MicroUsd;
  /** True when the destination parses as a 32-byte Solana address. */
  destinationValid: boolean;
  /** True when the destination equals the bot's own address. */
  destinationIsSelf: boolean;
}

/** Final server-side gate; every withdrawal must pass this before signing. */
export function planWithdrawal(input: WithdrawPlanInput): WithdrawPlan {
  if (!input.destinationValid) {
    return { ok: false, code: 'DESTINATION_INVALID', detail: 'destination is not a Solana address' };
  }
  if (input.destinationIsSelf) {
    return { ok: false, code: 'DESTINATION_IS_SELF', detail: 'destination is the bot wallet itself' };
  }
  if (input.amountBase <= 0n) {
    return { ok: false, code: 'AMOUNT_INVALID', detail: 'amount must be greater than 0' };
  }
  if (input.amountBase > input.withdrawableBase) {
    return {
      ok: false,
      code: 'INSUFFICIENT_AVAILABLE',
      detail:
        input.asset === 'SOL'
          ? 'amount exceeds SOL balance minus the fee reserve'
          : 'amount exceeds the free bankroll (funds in open positions cannot be withdrawn)',
    };
  }
  return { ok: true };
}

/** Format base units as a human decimal string (for CLI/UI display). */
export function formatBaseAmount(base: bigint, decimals: number): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
