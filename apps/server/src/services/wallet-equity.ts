import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { PriceProvider } from '@zcode-bot/providers';

/**
 * Wallet-truth equity (live mode): the numbers a block explorer would show.
 * Equity = USDC + SOL (priced) + the market value of the token balances behind
 * bot-tracked open positions. Nothing modelled enters these figures — fills
 * provide the trade delta used to tell deposits apart from trading.
 *
 * Persistence (kv): `wallet.equity` (latest snapshot), `wallet.bankroll`
 * (real cash/capital for the risk gates), `wallet.series` (sampled, ~24h),
 * `wallet.baseline` (first observed equity, captured once), `wallet.external`
 * (deposit/withdrawal ledger). Builder and the engine's gates read these.
 */

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Chain reads the service needs; the runtime binds them to a real connection. */
export interface WalletReader {
  getSolLamports(): Promise<bigint | null>;
  getTokenBalanceBase(mint: string): Promise<bigint | null>;
}

export interface WalletEquitySnapshot {
  asOf: string;
  usdcMicro: string;
  solLamports: string;
  solUsdMicro: string;
  positionsUsdMicro: string;
  equityUsdMicro: string;
  /** First observed equity, captured once; null until the first refresh. */
  baselineUsdMicro: string | null;
  /** Deposits minus withdrawals since the baseline (USDC). */
  externalNetUsdMicro: string;
  /** equity − baseline − externalNet; null before the baseline exists. */
  headlinePnlUsdMicro: string | null;
}

export interface BankrollSnapshot {
  /** Real USDC cash — the investable number (SOL is fee reserve). */
  cashUsdMicro: string;
  /** cash + the recorded USDC cost of open positions. */
  capitalUsdMicro: string;
}

const SERIES_INTERVAL_MS = 60_000;
const SERIES_MAX_AGE_MS = 24 * 3_600_000;
const EXTERNAL_SIGNIFICANT_MICRO = 1_000_000n; // $1: ignore rounding dust

export class WalletEquityService {
  private reader: WalletReader | null = null;
  private refreshing = false;

  constructor(
    private db: AppDatabase,
    private prices: PriceProvider,
    private rpcUrl: string,
    private ownerPublicKey: string,
    readerFactory?: (rpcUrl: string) => WalletReader,
  ) {
    if (readerFactory) this.reader = readerFactory(rpcUrl);
  }

  private async conn(): Promise<{
    getBalance(owner: unknown): Promise<number>;
    getParsedTokenAccountsByOwner(
      owner: unknown,
      filter: unknown,
    ): Promise<{
      value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
    }>;
  }> {
    const { Connection } = await import('@solana/web3.js');
    return new Connection(this.rpcUrl, 'confirmed') as never;
  }

  private async readerOverRpc(): Promise<WalletReader> {
    const { PublicKey } = await import('@solana/web3.js');
    const conn = await this.conn();
    const owner = new PublicKey(this.ownerPublicKey);
    return {
      getSolLamports: async () => BigInt(await conn.getBalance(owner)),
      getTokenBalanceBase: async (mint) => {
        const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
        let sum = 0n;
        for (const acc of res.value) {
          const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
          if (amount) sum += BigInt(amount);
        }
        return sum;
      },
    };
  }

  current(): WalletEquitySnapshot | null {
    const raw = repo.kvGet(this.db, 'wallet.equity');
    return raw ? (JSON.parse(raw) as WalletEquitySnapshot) : null;
  }

  currentBankroll(): BankrollSnapshot | null {
    const raw = repo.kvGet(this.db, 'wallet.bankroll');
    return raw ? (JSON.parse(raw) as BankrollSnapshot) : null;
  }

  series(): Array<{ t: string; usdMicro: string }> {
    const raw = repo.kvGet(this.db, 'wallet.series');
    return raw ? (JSON.parse(raw) as Array<{ t: string; usdMicro: string }>) : [];
  }

  async refresh(now = new Date()): Promise<WalletEquitySnapshot | null> {
    if (this.refreshing) return this.current();
    this.refreshing = true;
    try {
      const reader = this.reader ?? (await this.readerOverRpc());
      const solLamports = (await reader.getSolLamports().catch(() => null)) as bigint | null;
      if (solLamports === null) return this.current(); // RPC down: keep last truth

      const usdcRaw = await reader.getTokenBalanceBase(USDC_MINT).catch(() => null);
      if (usdcRaw === null) return this.current();
      // USDC has 6 decimals and micro-USD has 6 decimals: base == micro 1:1.
      const usdcMicro = usdcRaw;

      const solPrice = (await this.prices.priceOf(SOL_MINT, 9).catch(() => null))?.priceUsdMicro ?? 0n;
      const solUsdMicro = (solLamports * solPrice) / 1_000_000_000n;

      // Bot-tracked open positions only: open, partially closed, and stuck in
      // reconciliation (their tokens are still in the wallet).
      const held = repo
        .listPositions(this.db, 1000)
        .filter((p) => ['open', 'partially_closed', 'requires_reconciliation'].includes(p.status));
      const byMint = new Map<string, bigint>();
      for (const p of held) {
        byMint.set(p.mint, (byMint.get(p.mint) ?? 0n) + BigInt(p.remainingTokenBase));
      }
      let positionsUsdMicro = 0n;
      const marks = new Map<string, bigint>(); // mint -> USD value of the whole balance
      for (const [mint, recorded] of byMint) {
        const balance = await reader.getTokenBalanceBase(mint).catch(() => null);
        const base = balance ?? recorded; // unreadable: value the recorded size
        if (base === 0n) {
          marks.set(mint, 0n);
          continue;
        }
        const price = (await this.prices.priceOf(mint, 6).catch(() => null))?.priceUsdMicro ?? 0n;
        const value = (base * price) / 1_000_000n;
        marks.set(mint, value);
        positionsUsdMicro += value;
      }

      const equityUsdMicro = usdcMicro + solUsdMicro + positionsUsdMicro;

      // Deposits vs trading: expected USDC = last observed + net effect of our
      // live fills since then. Anything else is an external movement.
      const prev = this.current();
      let externalNet = prev ? BigInt(prev.externalNetUsdMicro) : 0n;
      let baseline = repo.kvGet(this.db, 'wallet.baseline') ?? null;
      if (!prev) {
        baseline = baseline ?? equityUsdMicro.toString();
        repo.kvSet(this.db, 'wallet.baseline', baseline);
      } else {
        const lastUsdc = BigInt(prev.usdcMicro);
        const tradeDelta = this.liveTradeDeltaUsdMicro(prev.asOf, now);
        const external = usdcMicro - lastUsdc - tradeDelta;
        if (external >= EXTERNAL_SIGNIFICANT_MICRO || external <= -EXTERNAL_SIGNIFICANT_MICRO) {
          externalNet += external;
          const ledger = this.externalLedger();
          ledger.push({
            t: now.toISOString(),
            deltaMicro: external.toString(),
            note:
              external > 0n
                ? 'deposit (unexplained USDC increase)'
                : 'withdrawal (unexplained USDC decrease)',
          });
          repo.kvSet(this.db, 'wallet.external', JSON.stringify(ledger.slice(-200)));
        }
      }

      const snapshot: WalletEquitySnapshot = {
        asOf: now.toISOString(),
        usdcMicro: usdcMicro.toString(),
        solLamports: solLamports.toString(),
        solUsdMicro: solUsdMicro.toString(),
        positionsUsdMicro: positionsUsdMicro.toString(),
        equityUsdMicro: equityUsdMicro.toString(),
        baselineUsdMicro: baseline,
        externalNetUsdMicro: externalNet.toString(),
        headlinePnlUsdMicro:
          baseline !== null ? (equityUsdMicro - BigInt(baseline) - externalNet).toString() : null,
      };
      repo.kvSet(this.db, 'wallet.equity', JSON.stringify(snapshot));

      const deployedCost = held.reduce((acc, p) => acc + BigInt(p.inputUsdMicro), 0n);
      const bankroll: BankrollSnapshot = {
        cashUsdMicro: usdcMicro.toString(),
        capitalUsdMicro: (usdcMicro + deployedCost).toString(),
      };
      repo.kvSet(this.db, 'wallet.bankroll', JSON.stringify(bankroll));

      this.appendSeries(now, equityUsdMicro);
      return snapshot;
    } finally {
      this.refreshing = false;
    }
  }

  /** Net USDC effect of OUR live fills between two instants (buys out, sells in). */
  private liveTradeDeltaUsdMicro(sinceIso: string, until: Date): bigint {
    let delta = 0n;
    for (const f of repo.listFills(this.db, 500)) {
      if (f.mode !== 'live') continue;
      const t = Date.parse(f.confirmedAt);
      if (!Number.isFinite(t) || t <= Date.parse(sinceIso) || t > until.getTime()) continue;
      const intent = repo.getIntent(this.db, f.intentId);
      if (!intent) continue;
      if (intent.kind === 'entry') delta -= BigInt(f.inputAmountBase);
      else delta += BigInt(f.outputAmountBase);
    }
    return delta; // USDC base == micro-USD, 1:1
  }

  private externalLedger(): Array<{ t: string; deltaMicro: string; note: string }> {
    const raw = repo.kvGet(this.db, 'wallet.external');
    return raw ? JSON.parse(raw) : [];
  }

  private appendSeries(now: Date, equityUsdMicro: bigint): void {
    const series = this.series();
    const last = series[series.length - 1];
    if (last && now.getTime() - Date.parse(last.t) < SERIES_INTERVAL_MS) return;
    series.push({ t: now.toISOString(), usdMicro: equityUsdMicro.toString() });
    const cutoff = now.getTime() - SERIES_MAX_AGE_MS;
    const kept = series.filter((p) => Date.parse(p.t) >= cutoff).slice(-1500);
    repo.kvSet(this.db, 'wallet.series', JSON.stringify(kept));
  }
}
