/** Formatting helpers for the redesigned dashboard. Money stays integer micro-USD. */

export function usdFromMicro(micro: string | bigint | null | undefined, decimals = 2): string {
  if (micro === null || micro === undefined) return '—';
  const n = typeof micro === 'bigint' ? micro : BigInt(micro);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, decimals);
  return `${neg ? '−' : ''}$${whole.toLocaleString('en-US')}${decimals > 0 ? `.${frac}` : ''}`;
}

export function signedUsdFromMicro(micro: string | bigint | null | undefined, decimals = 2): string {
  if (micro === null || micro === undefined) return '—';
  const n = typeof micro === 'bigint' ? micro : BigInt(micro);
  if (n === 0n) return usdFromMicro(0n, decimals);
  return `${n > 0n ? '+' : '−'}${usdFromMicro(n < 0n ? -n : n, decimals)}`;
}

export function compactInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function pct(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(decimals)}%`;
}

export function bpsPct(bps: number | null | undefined, decimals = 0): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(decimals)}%`;
}

export function ageLabel(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

const EET = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const EET_SHORT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function eetClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return EET.format(new Date(ms));
}

export function eetShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return EET_SHORT.format(new Date(ms));
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return '—';
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Initial shown in an avatar tile; handles arrive with or without '@'. */
export function avatarLetter(handle: string | null | undefined): string {
  const clean = (handle ?? '?').replace(/^@/, '');
  return (clean[0] ?? '?').toUpperCase();
}

const AVATAR_COLORS = [
  '#a78bfa',
  '#67e8f9',
  '#86efac',
  '#fda4af',
  '#fcd34d',
  '#93c5fd',
  '#f0abfc',
  '#5eead4',
  '#fdba74',
  '#c4b5fd',
];

export function avatarColor(handle: string | null | undefined): string {
  const text = handle ?? '';
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** 0.25 -> "0.25×"; 2 -> "2×". */
export function scaleLabel(scale: number): string {
  return `${Number.isInteger(scale) ? scale : scale.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
}

export function humanReason(reason: string | null | undefined): string {
  if (!reason) return '';
  return reason
    .replace(/^fired:\s*/i, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
