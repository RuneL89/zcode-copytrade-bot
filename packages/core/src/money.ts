/**
 * Decimal-safe money primitives.
 *
 * Authoritative monetary representation is an integer count of micro-USD
 * (1e-6 USD) held in a bigint. Token amounts are integer base units plus a
 * decimals exponent. JavaScript floating point is never authoritative.
 */

export type MicroUsd = bigint;

/** Whole-USD number to micro-USD bigint. Half-micro rounds toward zero. */
export function usdToMicro(usd: number): MicroUsd {
  if (!Number.isFinite(usd)) throw new Error('usdToMicro: not finite');
  const scaled = usd * 1e6;
  return BigInt(Math.trunc(scaled));
}

/** Micro-USD bigint to a plain number (display only, never authoritative). */
export function microToUsdNumber(micro: MicroUsd): number {
  return Number(micro) / 1e6;
}

/** Format micro-USD with 2 decimals, e.g. 1234567n -> "1.23". */
export function formatMicroUsd(micro: MicroUsd, decimals = 2): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / 1000000n;
  const frac = abs % 1000000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/** Split micro-USD into whole/faded-decimal parts for the equity hero. */
export function splitMicroUsd(micro: MicroUsd): { sign: string; whole: string; decimals: string } {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  return {
    sign: neg ? '-' : '',
    whole: (abs / 1000000n).toString(),
    decimals: (abs % 1000000n).toString().padStart(6, '0').slice(0, 2),
  };
}

/** Signed add. */
export function addMicro(a: MicroUsd, b: MicroUsd): MicroUsd {
  return a + b;
}

/** Signed subtract. */
export function subMicro(a: MicroUsd, b: MicroUsd): MicroUsd {
  return a - b;
}

/** Ratio a/b in basis points, floored. b must be > 0. */
export function ratioBps(num: bigint, den: bigint): number {
  if (den <= 0n) throw new Error('ratioBps: denominator must be positive');
  if (num < 0n) throw new Error('ratioBps: numerator must be non-negative');
  return Number((num * 10000n) / den);
}

/** Integer base-unit token amount with decimals metadata. */
export interface TokenAmount {
  /** Decimal-string integer of base units (e.g. lamports / smallest SPL unit). */
  base: string;
  decimals: number;
}

export function tokenAmount(base: bigint | string, decimals: number): TokenAmount {
  return { base: BigInt(base).toString(), decimals };
}

/** floor(amount * bps / 10000) in base units. */
export function applyBpsToBase(base: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10000) throw new Error(`applyBpsToBase: bps out of range: ${bps}`);
  return (base * BigInt(bps)) / 10000n;
}

/** Human display string for a token amount (display only). */
export function formatTokenAmount(amount: TokenAmount, maxDecimals = 4): string {
  const base = BigInt(amount.base);
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const pow = 10n ** BigInt(amount.decimals);
  const whole = abs / pow;
  const frac = amount.decimals > 0 ? (abs % pow).toString().padStart(amount.decimals, '0') : '';
  const shown = frac.slice(0, maxDecimals);
  return `${neg ? '-' : ''}${whole.toString()}${shown ? `.${shown}` : ''}`;
}

/** Deterministic canonical JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** JSON.stringify that renders bigint as a decimal string (audit records). */
export function stringifyBigIntSafe(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}
