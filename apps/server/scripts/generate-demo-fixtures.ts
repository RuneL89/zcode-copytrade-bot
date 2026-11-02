/**
 * Generates fixtures/demo-timeline.json — a deterministic, explicitly
 * FICTIONAL 28-second replay inspired by the reference post. Every value is
 * invented: $52 -> $4,939, 48 closes, 36 winners, switches at the compressed
 * equivalents of 05:16 and 13:55. Demo fixtures never touch live tables.
 *
 * Run: pnpm --filter @zcode-bot/server run fixtures:generate
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USD = (n: number) => BigInt(Math.round(n * 1e6)).toString();

const DURATION = 28;
// Compressed clock: 24h -> 28s. 05:16 -> 6.15s ; 13:55 -> 16.24s.
const SWITCH1_T = (+(5 * 3600 + 16 * 60) / (24 * 3600)) * DURATION;
const SWITCH2_T = (+(13 * 3600 + 55 * 60) / (24 * 3600)) * DURATION;

interface CloseEvent {
  t: number;
  type: 'close';
  pnlUsdMicro: string;
  equityAfterUsdMicro: string;
  symbol: string;
}
interface MirrorEvent {
  t: number;
  type: 'mirror';
  status: 'WATCHING' | 'QUOTING' | 'SUBMITTED' | 'CONFIRMED' | 'CLOSED';
  symbol: string;
  leaderUsd: number;
  copyUsd: number;
  pnlUsd: number | null;
}
interface SwitchEvent {
  t: number;
  type: 'switch';
  fromHandle: string;
  fromRank: number;
  toHandle: string | null;
  toRank: number | null;
  reason: string;
  equityAfterUsdMicro: string;
}
type TimelineEvent = CloseEvent | MirrorEvent | SwitchEvent;

function phasePnls(
  rng: () => number,
  wins: number,
  losses: number,
  netUsd: number,
  lossAvg: number,
): number[] {
  // Losses are ALWAYS negative and sum to -losses*lossAvg; wins sum to
  // net + |losses| so the phase lands on its exact target equity.
  const lossesAbs = losses * lossAvg;
  const winTotal = netUsd + lossesAbs;
  const out: number[] = [];
  let winBudget = winTotal;
  for (let i = 0; i < wins; i++) {
    const remain = wins - i;
    const base = winBudget / remain;
    const jitter =
      remain > 1
        ? Math.min(Math.abs(base) * 0.4, 0.4 * base * (rng() - 0.5) + 0.2 * Math.abs(base) * (rng() - 0.5))
        : 0;
    const v = Math.max(0.6, base + jitter);
    out.push(v);
    winBudget -= v;
  }
  let lossBudget = -lossesAbs;
  for (let i = 0; i < losses; i++) {
    const remain = losses - i;
    const base = lossBudget / remain;
    const jitter = remain > 1 ? 0.4 * Math.abs(base) * (rng() - 0.5) : 0;
    const v = Math.min(-0.6, base + jitter);
    out.push(v);
    lossBudget -= v;
  }
  // Fix rounding drift on the final win without flipping its sign.
  const drift = netUsd - out.reduce((a, b) => a + b, 0);
  const lastWinIdx =
    out
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0)
      .pop() ?? out.length - 1;
  out[lastWinIdx] = Math.max(0.6, out[lastWinIdx]! + drift);
  return out;
}

function build() {
  const rng = mulberry32(42);
  const events: TimelineEvent[] = [];

  const PHASES = [
    {
      handle: 'ape_vasco',
      rank: 1,
      from: 0,
      to: SWITCH1_T,
      startUsd: 52,
      endUsd: 73,
      wins: 3,
      losses: 2,
      lossAvg: 1.4,
      symbols: ['MEOWX', 'DOGWIF'],
    },
    {
      handle: 'moonpie_max',
      rank: 3,
      from: SWITCH1_T,
      to: SWITCH2_T,
      startUsd: 73,
      endUsd: 520,
      wins: 15,
      losses: 2,
      lossAvg: 4.0,
      symbols: ['PNUTZ', 'GIGA2', 'SOLA'],
    },
    {
      handle: 'lunadegen',
      rank: 2,
      from: SWITCH2_T,
      to: DURATION,
      startUsd: 520,
      endUsd: 4939,
      wins: 18,
      losses: 8,
      lossAvg: 9.0,
      symbols: ['WIFHM', 'BONKX', 'TRUMPY', 'MYRO'],
    },
  ] as const;

  let equity = 52;
  const closesTotal = 48;
  const winnersTotal = 36;
  let closeCount = 0;

  for (const phase of PHASES) {
    const span = phase.to - phase.from;
    const net = phase.endUsd - phase.startUsd;
    // Order: wins/losses interleaved, but the final TWO closes of a fired
    // trader are the consecutive losses that trigger the switch.
    const pnls = phasePnls(rng, phase.wins, phase.losses, net, phase.lossAvg);
    const seq: number[] = [];
    const winList = pnls.filter((p) => p > 0);
    const allLosses = pnls.filter((p) => p <= 0);
    const lossList = allLosses.slice(0, Math.max(0, allLosses.length - 2));
    const finalLosses = allLosses.slice(Math.max(0, allLosses.length - 2)); // last two losses fire the trader
    // Interleave deterministically.
    let wi = 0;
    let li = 0;
    const totalMid = winList.length + lossList.length;
    for (let i = 0; i < totalMid; i++) {
      const takeWin =
        (wi < winList.length && (li >= lossList.length || rng() < 0.72)) || li >= lossList.length;
      if (takeWin && wi < winList.length) seq.push(winList[wi++]!);
      else if (li < lossList.length) seq.push(lossList[li++]!);
      else seq.push(winList[wi++]!);
    }
    seq.push(...finalLosses);

    // Integer-cent bookkeeping; the phase's last close absorbs rounding so the
    // phase lands on its exact target equity.
    const seqCents = seq.map((v) => Math.round(v * 100));
    const lastIdx = seqCents.length - 1;
    const sumBeforeLast = seqCents.slice(0, lastIdx).reduce((a, b) => a + b, 0);
    const targetCents = Math.round(phase.endUsd * 100);
    const startCents = Math.round(phase.startUsd * 100);
    seqCents[lastIdx] = targetCents - startCents - sumBeforeLast;
    if (seqCents[lastIdx] >= 0) {
      throw new Error(`${phase.handle}: final forced close must be a loss, got ${seqCents[lastIdx]}`);
    }

    const closes = seqCents.length;
    let equityCents = startCents;
    for (let i = 0; i < closes; i++) {
      const t = +(phase.from + ((i + 1) / (closes + 1)) * span).toFixed(2);
      equityCents += seqCents[i]!;
      closeCount++;
      events.push({
        t,
        type: 'close',
        pnlUsdMicro: (BigInt(seqCents[i]!) * 10000n).toString(),
        equityAfterUsdMicro: (BigInt(equityCents) * 10000n).toString(),
        symbol: phase.symbols[i % phase.symbols.length]!,
      });
    }

    // Mirror-card activity: two cycles per phase.
    const mirrorCount = 2;
    for (let m = 0; m < mirrorCount; m++) {
      const mt = +(phase.from + ((m + 0.5) / mirrorCount) * span).toFixed(2);
      const leaderUsd = Math.max(40, Math.round(net > 0 ? 120 + rng() * 400 : 60 + rng() * 120));
      const copyUsd = +(leaderUsd * 0.25).toFixed(2);
      const sym = phase.symbols[m % phase.symbols.length]!;
      events.push({
        t: mt,
        type: 'mirror',
        status: 'WATCHING',
        symbol: sym,
        leaderUsd,
        copyUsd,
        pnlUsd: null,
      });
      events.push({
        t: +(mt + 0.3).toFixed(2),
        type: 'mirror',
        status: 'QUOTING',
        symbol: sym,
        leaderUsd,
        copyUsd,
        pnlUsd: null,
      });
      events.push({
        t: +(mt + 0.6).toFixed(2),
        type: 'mirror',
        status: 'SUBMITTED',
        symbol: sym,
        leaderUsd,
        copyUsd,
        pnlUsd: null,
      });
      events.push({
        t: +(mt + 0.9).toFixed(2),
        type: 'mirror',
        status: 'CONFIRMED',
        symbol: sym,
        leaderUsd,
        copyUsd,
        pnlUsd: null,
      });
      events.push({
        t: +(mt + Math.min(2.2, span / (mirrorCount + 1))).toFixed(2),
        type: 'mirror',
        status: 'CLOSED',
        symbol: sym,
        leaderUsd,
        copyUsd,
        pnlUsd: +(copyUsd * (rng() * 1.6 - 0.4)).toFixed(2),
      });
    }

    // Switch at the end of the phase (last phase has none).
    if (phase.to < DURATION) {
      const next = PHASES.find((p) => p.from === phase.to);
      events.push({
        t: +phase.to.toFixed(2),
        type: 'switch',
        fromHandle: phase.handle,
        fromRank: phase.rank,
        toHandle: next ? next.handle : null,
        toRank: next ? next.rank : null,
        reason: '2 consecutive losses',
        equityAfterUsdMicro: USD(phase.endUsd),
      });
    }
  }

  events.sort((a, b) => a.t - b.t);

  const timeline = {
    schemaVersion: 1 as const,
    meta: {
      fictional: true as const,
      label: 'FICTIONAL DEMO · NOT A PERFORMANCE CLAIM',
      durationSeconds: DURATION,
      switch1Seconds: +SWITCH1_T.toFixed(2),
      switch2Seconds: +SWITCH2_T.toFixed(2),
      inspiredByReference: true,
    },
    start: { equityUsdMicro: USD(52), handle: 'ape_vasco', weeklyRank: 1 },
    traders: PHASES.map((p) => ({
      handle: p.handle,
      weeklyRank: p.rank,
      displayedPnl7dPct: [438, 297, 512][p.rank === 1 ? 0 : p.rank === 3 ? 1 : 2] ?? 100,
    })),
    events,
    end: { equityUsdMicro: USD(4939), trades: closeCount, winners: winnersTotal },
  };

  // Sanity assertions (the generator is deterministic; guard anyway).
  if (closeCount !== closesTotal) throw new Error(`expected ${closesTotal} closes, got ${closeCount}`);
  const winEvents = events.filter((e) => e.type === 'close' && BigInt(e.pnlUsdMicro) > 0n);
  if (winEvents.length !== winnersTotal)
    throw new Error(`expected ${winnersTotal} winners, got ${winEvents.length}`);
  const final = events.filter((e) => e.type === 'close').pop() as CloseEvent;
  if (final.equityAfterUsdMicro !== USD(4939))
    throw new Error(`expected final equity 4939, got ${final.equityAfterUsdMicro}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, '..', '..', '..', 'fixtures', 'demo-timeline.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(timeline, null, 2) + '\n');
  console.log(`wrote ${outPath} (${events.length} events, ${closeCount} closes)`);
}

build();
