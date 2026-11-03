import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  canPromote,
  canReenter,
  ceilingAction,
  classifyFundedSwap,
  computeCopyNotional,
  promotionRecordDecision,
  usdToMicro,
  type FundedSwap,
  type PromotionBlockReason,
} from '@zcode-bot/core';
import type { HeliusProvider, PriceProvider, PublicSolanaProvider } from '@zcode-bot/providers';
import type { TraderLifecycle } from './lifecycle.js';

/**
 * Watch list + shadow ledger (D4).
 *
 * A watched wallet is observed through its own funded swaps (the ONE definition
 * in `core/swap.ts`): every funded buy opens a pretend position at our notional
 * (the D1 clamp), every funded sell closes lots FIFO at the leader's price, and
 * a position that reaches the age ceiling closes at a live quote. That record is
 * the promotion evidence — the fomo PnL mark is never an input.
 *
 * Everything is fail-closed: an unreadable transaction, an unpriceable mint or
 * a missing quote never invents a fill, a price, a notional or a promotion.
 */

/** Sizing helper: the D1 clamp on the leader's input notional (shared with the copier). */
export function shadowNotionalUsdMicro(leaderInputUsdMicro: bigint, risk: RiskConfig): bigint | null {
  const sizing = computeCopyNotional({
    leaderInputUsdMicro,
    scaleNumerator: BigInt(Math.round(risk.COPY_SCALE * 10000)),
    scaleDenominator: 10000n,
    minPerBuyUsdMicro: usdToMicro(risk.MIN_PER_BUY_USD),
    maxPerBuyUsdMicro: usdToMicro(risk.MAX_PER_BUY_USD),
  });
  return sizing.action === 'copy' ? sizing.finalUsdMicro : null;
}

/**
 * D4's working assumption for the shadow ledger: 1% slippage per side. We are
 * assumed to pay 1% above the leader's entry and to receive 1% below his exit,
 * so a round trip at an unchanged price books a small loss instead of a fake
 * zero. The lot stores the RAW prices (that is the evidence); only the PnL the
 * promotion bar is measured against carries the assumption.
 */
export const SHADOW_SLIPPAGE_BPS = 100;

export function shadowPnlUsdMicro(
  notionalUsdMicro: bigint,
  entryUsdMicro: bigint,
  exitUsdMicro: bigint,
): bigint {
  const effectiveEntry = (entryUsdMicro * (10_000n + BigInt(SHADOW_SLIPPAGE_BPS))) / 10_000n;
  const effectiveExit = (exitUsdMicro * (10_000n - BigInt(SHADOW_SLIPPAGE_BPS))) / 10_000n;
  if (effectiveEntry <= 0n) return 0n;
  return (notionalUsdMicro * effectiveExit) / effectiveEntry - notionalUsdMicro;
}

/** The funded-buy reading admission is decided from. */
export interface AdmissionReading {
  /** Funded buys in the lookback (D4 definition). */
  fundedBuys24h: number;
  /** Newest funded buy, ISO; null when there is none. */
  lastFundedBuyAt: string | null;
  /** When this reading was measured (freshness gate). */
  measuredAt: string;
  /** The scan's funded events, oldest first — used for the optional backfill. */
  events: FundedSwap[];
}

export interface WatchTickResult {
  polled: number;
  newEvents: number;
  ceilingsClosed: number;
  admitted: number;
  promoted: number;
  hired: string | null;
  demoted: number;
  archived: number;
  errors: string[];
}

export interface WatchServiceDeps {
  db: AppDatabase;
  risk: RiskConfig;
  publicSolana: PublicSolanaProvider;
  helius: HeliusProvider;
  prices: PriceProvider;
  lifecycle: TraderLifecycle;
  onStateChanged: () => void;
}

/** How many transactions one poll / scan inspects per wallet. */
const WATCH_TX_SCAN_LIMIT = 25;
/** Candidates scanned for admission per tick (bounded spend). */
export const ADMISSION_SCAN_PER_TICK = 3;
/** Admission reads look back 24h (D4's window). */
const ADMISSION_LOOKBACK_HOURS = 24;

export class WatchService {
  constructor(private deps: WatchServiceDeps) {}

  private get db(): AppDatabase {
    return this.deps.db;
  }

  private get risk(): RiskConfig {
    return this.deps.risk;
  }

  // ---- provider helpers (public RPC first, Helius fallback — D5) -------------

  private async signaturePage(
    address: string,
    limit: number,
  ): Promise<Array<{ signature: string; blockTime: number | null }>> {
    if (this.deps.publicSolana.configured) {
      try {
        const rows = await this.deps.publicSolana.recentSignatures(address, limit);
        return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
      } catch {
        // Public node unavailable: the paid fallback below answers.
      }
    }
    const rows = await this.deps.helius.recentSignatures(address, limit);
    return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
  }

  private async txSummary(address: string, signature: string) {
    if (this.deps.publicSolana.configured) {
      try {
        const summary = await this.deps.publicSolana.transactionSummary(address, signature);
        if (summary) return summary;
      } catch {
        // Fall through to Helius.
      }
    }
    return this.deps.helius.transactionSummary(address, signature).catch(() => null);
  }

  /** The mint's decimals as our own funded-swap record saw them (pricing needs them). */
  private decimalsFor(candidateId: string, mint: string): number | null {
    const event = repo.listWatchEvents(this.db, candidateId, 200).find((e) => e.mint === mint);
    return event ? event.decimals : null;
  }

  /** Micro-USD notional of a swap's funding leg; null when it cannot be priced. */
  private async fundingUsdMicro(swap: FundedSwap): Promise<bigint | null> {
    if (swap.fundingMint === 'SOL') {
      try {
        const price = await this.deps.prices.priceOf('So11111111111111111111111111111111111111112', 9);
        return (swap.fundingDeltaBase * price.priceUsdMicro) / 10n ** 9n;
      } catch {
        return null; // no quote: never invent a notional
      }
    }
    // A stable funding leg is already USD: 6-decimal base units are micro-USD.
    return swap.fundingDeltaBase;
  }

  // ---- admission -----------------------------------------------------------

  /**
   * Admit a wallet to the watch list from a funded-buy reading (D4:
   * ≥ ADMISSION_MIN_BUYS_24H funded buys and the last one within
   * ADMISSION_MAX_LAST_BUY_HOURS). The cursor starts at the tip, so nothing
   * from before admission is ever copied.
   */
  async admit(candidateId: string, reading: AdmissionReading): Promise<{ ok: boolean; reason: string }> {
    const risk = this.risk;
    const measuredMs = Date.parse(reading.measuredAt);
    const freshnessMs = Math.max(risk.WATCH_POLL_MS * 2, 30 * 60_000);
    if (!Number.isFinite(measuredMs) || Date.now() - measuredMs > freshnessMs) {
      return { ok: false, reason: 'STALE_READING' };
    }
    if (reading.fundedBuys24h < risk.ADMISSION_MIN_BUYS_24H) {
      return { ok: false, reason: 'TOO_FEW_FUNDED_BUYS' };
    }
    const lastBuyMs = reading.lastFundedBuyAt === null ? null : Date.parse(reading.lastFundedBuyAt);
    if (lastBuyMs === null || Date.now() - lastBuyMs > risk.ADMISSION_MAX_LAST_BUY_HOURS * 3_600_000) {
      return { ok: false, reason: 'LAST_BUY_TOO_OLD' };
    }

    const candidate = repo.getCandidate(this.db, candidateId);
    if (!candidate) return { ok: false, reason: 'UNKNOWN_CANDIDATE' };
    const address = repo
      .listCandidateAddresses(this.db, candidateId)
      .find((a) => a.chain === 'solana')?.address;
    if (!address) return { ok: false, reason: 'NO_WALLET' };

    repo.upsertWatchWallet(this.db, {
      candidateId,
      userId: candidate.userId,
      address,
      status: 'watching',
      reason: 'admission',
    });

    const cursor = await this.deps.helius.latestCursor(address).catch(() => null);
    repo.setWatchCursor(this.db, {
      address,
      candidateId,
      lastSignature: cursor?.lastSignature ?? '',
      lastSlot: cursor?.lastSlot ?? 0,
      lastTransactionIndex: cursor?.lastTransactionIndex ?? 0,
    });

    let backfilled = 0;
    if (this.risk.SHADOW_BACKFILL_ON_ADMIT) {
      // Seed the shadow record from the admission scan's OBSERVED events only:
      // they are real on-chain trades, replayed oldest-first.
      for (const event of reading.events) {
        if (await this.applyFundedSwap(candidateId, address, event)) backfilled++;
      }
    }

    repo.audit(
      this.db,
      'watch',
      `watch admitted: ${candidate.handle} (${reading.fundedBuys24h} funded buys/24h)`,
      {
        candidateId,
        address,
        fundedBuys24h: reading.fundedBuys24h,
        lastFundedBuyAt: reading.lastFundedBuyAt,
        backfilled,
      },
    );
    this.deps.onStateChanged();
    return { ok: true, reason: 'ADMITTED' };
  }

  /** Scan one wallet for funded swaps over the lookback window. */
  async scanWallet(address: string, lookbackHours = ADMISSION_LOOKBACK_HOURS): Promise<AdmissionReading> {
    const measuredAt = new Date().toISOString();
    const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
    const rows = await this.signaturePage(address, 100).catch(() => []);
    const inWindow = rows.filter((r) => r.blockTime !== null && r.blockTime >= cutoffSec);

    const events: FundedSwap[] = [];
    for (const row of inWindow.slice(0, WATCH_TX_SCAN_LIMIT)) {
      const summary = await this.txSummary(address, row.signature);
      if (!summary) continue;
      const swap = classifyFundedSwap(summary);
      if (swap) events.push(swap);
    }
    events.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    const buys = events.filter((e) => e.side === 'buy');
    const newestBuy = buys[buys.length - 1] ?? null;
    return {
      fundedBuys24h: buys.length,
      lastFundedBuyAt:
        newestBuy && newestBuy.blockTime !== null ? new Date(newestBuy.blockTime * 1000).toISOString() : null,
      measuredAt,
      events,
    };
  }

  // ---- shadow ledger -------------------------------------------------------

  /**
   * Record one observed funded swap: idempotent event row, then the shadow
   * effect (open a lot on a buy, close FIFO on a sell). Returns true when the
   * event was new.
   */
  async applyFundedSwap(candidateId: string, address: string, swap: FundedSwap): Promise<boolean> {
    const key = `${candidateId}|${swap.signature}|${swap.side}`;
    // The unique key in watch_events is the durable guarantee; this set also
    // blocks a double-apply inside one run while a slow price lookup is in
    // flight.
    if (this.seenShadowEvents.has(key)) return false;
    const observedAt = new Date().toISOString();
    const tokens = swap.tokenDeltaBase < 0n ? -swap.tokenDeltaBase : swap.tokenDeltaBase;
    const inserted = repo.insertWatchEvent(this.db, {
      candidateId,
      address,
      signature: swap.signature,
      side: swap.side,
      mint: swap.mint,
      tokenAmountBase: tokens.toString(),
      decimals: swap.decimals,
      usdMicro: '0',
      blockTime: swap.blockTime ?? 0,
      observedAt,
      source: 'watch-poll',
    });
    if (!inserted) return false;
    this.seenShadowEvents.add(key);

    if (swap.side === 'buy') await this.openShadowFromBuy(candidateId, swap);
    else await this.closeShadowFromSell(candidateId, swap, observedAt);
    return true;
  }

  /** In-run dedupe so a slow price lookup cannot double-apply the same event. */
  private seenShadowEvents = new Set<string>();

  private async openShadowFromBuy(candidateId: string, swap: FundedSwap): Promise<void> {
    const tokens = swap.tokenDeltaBase > 0n ? swap.tokenDeltaBase : -swap.tokenDeltaBase;
    if (tokens <= 0n) return;
    let inputUsdMicro: bigint | null = null;
    try {
      inputUsdMicro = await this.fundingUsdMicro(swap);
    } catch {
      inputUsdMicro = null; // unpriced: the event row stays, the shadow does not
    }
    if (inputUsdMicro === null) return;
    const notional = shadowNotionalUsdMicro(inputUsdMicro, this.risk);
    if (notional === null) return;
    const scale = 10n ** BigInt(Math.max(0, swap.decimals));
    // The lot is priced at the LEADER's price (what he paid per coin); our
    // notional only decides how much of the pretend position we take.
    const entryPriceUsdMicro = (inputUsdMicro * scale) / tokens;
    if (entryPriceUsdMicro <= 0n) return;
    repo.openShadowTrade(this.db, {
      candidateId,
      mint: swap.mint,
      openedAt: new Date((swap.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      entryPriceUsdMicro: entryPriceUsdMicro.toString(),
      notionalUsdMicro: notional.toString(),
    });
    repo.audit(this.db, 'watch', 'shadow opened at our notional (D1 clamp)', {
      candidateId,
      signature: swap.signature,
      mint: swap.mint,
      notionalUsdMicro: notional.toString(),
      entryPriceUsdMicro: entryPriceUsdMicro.toString(),
    });
    this.deps.onStateChanged();
  }

  /**
   * Leader sell → close FIFO lots at the leader's price. A partial sell closes
   * proportionally: the closed part becomes a row, the remainder stays open
   * with its original entry price and open time.
   */
  private async closeShadowFromSell(candidateId: string, swap: FundedSwap, closedAt: string): Promise<void> {
    const soldTokens = swap.tokenDeltaBase < 0n ? -swap.tokenDeltaBase : swap.tokenDeltaBase;
    if (soldTokens <= 0n) return;
    let proceedsUsdMicro: bigint | null = null;
    try {
      proceedsUsdMicro = await this.fundingUsdMicro(swap);
    } catch {
      proceedsUsdMicro = null; // unpriced: the lot stays open and the ceiling handles it
    }
    if (proceedsUsdMicro === null) return;
    const scale = 10n ** BigInt(Math.max(0, swap.decimals));
    const exitPriceUsdMicro = (proceedsUsdMicro * scale) / soldTokens;
    if (exitPriceUsdMicro <= 0n) return;

    let remainingSold = soldTokens;
    const lots = repo.listOpenShadowTrades(this.db, candidateId).filter((l) => l.mint === swap.mint);
    for (const lot of lots) {
      if (remainingSold <= 0n) break;
      const entry = BigInt(lot.entryPriceUsdMicro);
      const notional = BigInt(lot.notionalUsdMicro);
      if (entry <= 0n) continue;
      const lotTokens = (notional * scale) / entry;
      if (lotTokens <= 0n) continue;

      const closingAll = remainingSold >= lotTokens;
      const closedTokens = closingAll ? lotTokens : remainingSold;
      // Integer math with the remainder left in the open lot keeps the
      // ledger's total notional conserved to the micro-USD.
      const closedNotional = closingAll ? notional : (notional * closedTokens) / lotTokens;
      // D4's working assumption rides in the PnL, not in the stored prices.
      const pnl = shadowPnlUsdMicro(closedNotional, entry, exitPriceUsdMicro);

      if (closingAll) {
        repo.closeShadowTrade(this.db, lot.id, {
          closedAt,
          exitReason: 'leader_sell',
          exitPriceUsdMicro: exitPriceUsdMicro.toString(),
          pnlUsdMicro: pnl.toString(),
        });
      } else {
        const closedId = repo.openShadowTrade(this.db, {
          candidateId,
          mint: swap.mint,
          openedAt: lot.openedAt,
          entryPriceUsdMicro: entry.toString(),
          notionalUsdMicro: closedNotional.toString(),
        });
        repo.closeShadowTrade(this.db, closedId, {
          closedAt,
          exitReason: 'leader_sell',
          exitPriceUsdMicro: exitPriceUsdMicro.toString(),
          pnlUsdMicro: pnl.toString(),
        });
        repo.updateShadowTradeNotional(this.db, lot.id, (notional - closedNotional).toString());
      }
      remainingSold -= closedTokens;
    }

    repo.audit(this.db, 'watch', 'shadow closed at the leader price (leader sell)', {
      candidateId,
      signature: swap.signature,
      mint: swap.mint,
      soldTokens: soldTokens.toString(),
      exitPriceUsdMicro: exitPriceUsdMicro.toString(),
    });
    this.deps.onStateChanged();
  }

  /** Ceiling: MAX_POSITION_AGE_HOURS, + POSITION_GRACE_HOURS when the mark is not positive. */
  private async closeDueCeilings(): Promise<number> {
    let closed = 0;
    for (const lot of repo.listOpenShadowTrades(this.db)) {
      const decimals = this.decimalsFor(lot.candidateId, lot.mint);
      if (decimals === null) continue; // cannot price without the mint's scale
      let mark: bigint | null = null;
      try {
        mark = (await this.deps.prices.priceOf(lot.mint, decimals)).priceUsdMicro;
      } catch {
        mark = null; // no quote: retry next tick, never invent a price
      }
      const entry = BigInt(lot.entryPriceUsdMicro);
      const decision = ceilingAction({
        openedAt: lot.openedAt,
        nowMs: Date.now(),
        maxAgeHours: this.risk.MAX_POSITION_AGE_HOURS,
        graceHours: this.risk.POSITION_GRACE_HOURS,
        markUsdMicro: mark,
        entryUsdMicro: entry,
      });
      if (decision !== 'close_now' || mark === null) continue;
      const notional = BigInt(lot.notionalUsdMicro);
      const pnl = shadowPnlUsdMicro(notional, entry, mark);
      repo.closeShadowTrade(this.db, lot.id, {
        closedAt: new Date().toISOString(),
        exitReason: 'ceiling',
        exitPriceUsdMicro: mark.toString(),
        pnlUsdMicro: pnl.toString(),
      });
      repo.audit(
        this.db,
        'watch',
        `ceiling closed at $${(Number(mark) / 1e6).toFixed(6)} after ${this.risk.MAX_POSITION_AGE_HOURS}h` +
          ` (grace ${this.risk.POSITION_GRACE_HOURS}h when the mark was not positive)`,
        { candidateId: lot.candidateId, mint: lot.mint, openedAt: lot.openedAt },
      );
      closed++;
    }
    if (closed > 0) this.deps.onStateChanged();
    return closed;
  }

  // ---- ticks ---------------------------------------------------------------

  /** Poll every watching wallet, apply new funded swaps, then evaluate. */
  async tick(): Promise<WatchTickResult> {
    const result: WatchTickResult = {
      polled: 0,
      newEvents: 0,
      ceilingsClosed: 0,
      admitted: 0,
      promoted: 0,
      hired: null,
      demoted: 0,
      archived: 0,
      errors: [],
    };

    result.ceilingsClosed = await this.closeDueCeilings();

    // Watching AND promoted: D4 keeps the shadow record running after
    // promotion as the would-have-copied baseline.
    for (const wallet of [
      ...repo.listWatchWallets(this.db, 'watching'),
      ...repo.listWatchWallets(this.db, 'promoted'),
    ]) {
      try {
        result.newEvents += await this.pollWallet(wallet.candidateId, wallet.address);
        result.polled++;
      } catch (e) {
        result.errors.push(`${wallet.candidateId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const evaluation = await this.evaluate();
    result.admitted = evaluation.admitted;
    result.promoted = evaluation.promoted;
    result.hired = evaluation.hired;
    result.demoted = evaluation.demoted;
    result.archived = evaluation.archived;
    return result;
  }

  /** Read new signatures for one watched wallet and apply its funded swaps. */
  private async pollWallet(candidateId: string, address: string): Promise<number> {
    const cursor = repo.getWatchCursor(this.db, address);
    const rows = await this.signaturePage(address, WATCH_TX_SCAN_LIMIT);
    const fresh = rows.filter((r) => r.signature.length > 0 && r.signature !== cursor?.lastSignature);
    if (fresh.length === 0) return 0;

    // Newest-first from the RPC; apply oldest-first so FIFO stays honest.
    let applied = 0;
    for (const row of [...fresh].reverse()) {
      const summary = await this.txSummary(address, row.signature);
      if (!summary) continue;
      const swap = classifyFundedSwap(summary);
      if (swap && (await this.applyFundedSwap(candidateId, address, swap))) applied++;
    }
    repo.setWatchCursor(this.db, {
      address,
      candidateId,
      lastSignature: rows[0]!.signature,
      lastSlot: cursor?.lastSlot ?? 0,
      lastTransactionIndex: 0,
    });
    return applied;
  }

  /**
   * Admission scan (bounded per tick), demotion/eviction, then promotion.
   */
  async evaluate(): Promise<{
    admitted: number;
    promoted: number;
    hired: string | null;
    demoted: number;
    archived: number;
  }> {
    let admitted = 0;
    let promoted = 0;
    let hired: string | null = null;
    let demoted = 0;
    let archived = 0;

    // --- admission: candidates with a wallet that are not already on the list ---
    // The list is ordered least-recently-measured first (never-measured ahead of
    // everything), so the bounded scan advances through the pool. A scan that
    // finds nothing still records its reading, which is what moves the candidate
    // to the back of the queue for the next tick.
    const candidates = repo.listAdmissionScanCandidates(this.db, ADMISSION_SCAN_PER_TICK);
    for (const candidate of candidates) {
      const address = repo
        .listCandidateAddresses(this.db, candidate.candidateId)
        .find((a) => a.chain === 'solana')?.address;
      if (!address) continue;
      try {
        const reading = await this.scanWallet(address);
        const newestEvent = reading.events[reading.events.length - 1] ?? null;
        repo.updateCandidateActivity(this.db, candidate.candidateId, {
          swaps24h: reading.events.length,
          lastSwapAt:
            newestEvent?.blockTime != null ? new Date(newestEvent.blockTime * 1000).toISOString() : null,
          lastBuyAt: reading.lastFundedBuyAt,
          buys24h: reading.fundedBuys24h,
          sells24h: reading.events.filter((e) => e.side === 'sell').length,
          status: 'ok',
          checkedAt: reading.measuredAt,
        });
        const verdict = await this.admit(candidate.candidateId, reading);
        if (verdict.ok) admitted++;
      } catch (e) {
        repo.audit(
          this.db,
          'watch',
          `admission scan failed for ${candidate.handle} (fail closed): ${e instanceof Error ? e.message : e}`,
          {},
        );
      }
    }

    // --- eviction + demotion -------------------------------------------------
    const now = Date.now();
    for (const wallet of repo.listWatchWallets(this.db, 'watching')) {
      const lastBuyMs = wallet.lastFundedBuyAt === null ? null : Date.parse(wallet.lastFundedBuyAt);
      const quietDays = lastBuyMs === null ? null : (now - lastBuyMs) / (24 * 3_600_000);
      if (quietDays !== null && quietDays >= this.risk.WATCH_EVICTION_DAYS) {
        repo.setWatchStatus(this.db, wallet.candidateId, 'archived', 'no funded buy for the eviction window');
        repo.audit(this.db, 'watch', 'watch archived: no funded buy for the eviction window', {
          candidateId: wallet.candidateId,
          lastFundedBuyAt: wallet.lastFundedBuyAt,
        });
        archived++;
        continue;
      }
      const aggregates = repo.shadowAggregates(this.db, wallet.candidateId);
      if (aggregates.closedCount >= this.risk.PROMOTION_MIN_CLOSED && aggregates.netPnlUsdMicro <= 0n) {
        repo.setWatchStatus(
          this.db,
          wallet.candidateId,
          'archived',
          'negative shadow record with a full sample',
        );
        repo.audit(this.db, 'watch', 'watch demoted: negative shadow record with a full sample', {
          candidateId: wallet.candidateId,
          closedCount: aggregates.closedCount,
          netPnlUsdMicro: aggregates.netPnlUsdMicro.toString(),
        });
        demoted++;
      }
    }

    // --- bench hygiene -------------------------------------------------------
    // Promotion is not a permanent pass. A wallet waiting for a chair whose
    // record no longer qualifies (net fell, last buy went stale, or it was
    // fired and has not bought since) leaves the bench: to the watch list, or
    // archived when the sample is full and negative. Without this a stale bench
    // row could be hired the moment a chair frees.
    for (const wallet of repo.listWatchWallets(this.db, 'promoted')) {
      const aggregates = repo.shadowAggregates(this.db, wallet.candidateId);
      if (aggregates.closedCount >= this.risk.PROMOTION_MIN_CLOSED && aggregates.netPnlUsdMicro <= 0n) {
        repo.setWatchStatus(
          this.db,
          wallet.candidateId,
          'archived',
          'negative shadow record with a full sample',
        );
        repo.audit(this.db, 'watch', 'bench demoted: negative shadow record with a full sample', {
          candidateId: wallet.candidateId,
          closedCount: aggregates.closedCount,
          netPnlUsdMicro: aggregates.netPnlUsdMicro.toString(),
        });
        demoted++;
        continue;
      }
      const record = promotionRecordDecision(this.recordInput(wallet.candidateId));
      if (!record.ok) {
        repo.setWatchStatus(this.db, wallet.candidateId, 'watching', `bench demoted: ${record.reason}`);
        repo.audit(this.db, 'watch', `bench demoted: ${record.reason}`, {
          candidateId: wallet.candidateId,
        });
        demoted++;
      }
    }

    // --- promotion ----------------------------------------------------------
    const promotable: string[] = [];
    for (const wallet of repo.listWatchWallets(this.db, 'watching')) {
      const decision = this.promotionDecision(wallet.candidateId);
      if (decision.ok) promotable.push(wallet.candidateId);
      else if (decision.reason === 'REENTRY_BANNED') {
        repo.audit(this.db, 'watch', 're-entry blocked (no funded buy since the firing)', {
          candidateId: wallet.candidateId,
        });
      }
    }
    for (const candidateId of promotable) {
      const block = this.promotionDecision(candidateId);
      if (!block.ok) continue; // the live slot/headroom moved between checks
      repo.setWatchStatus(this.db, candidateId, 'promoted', 'promotion gate passed');
      repo.audit(this.db, 'watch', 'watch promoted: promotion gate passed', { candidateId });
      promoted++;
      if (hired === null) {
        // Plan 04 wires the hand-off to the existing single-chair activate();
        // plan 05 makes the roster multi-chair aware.
        const attempt = await this.deps.lifecycle.hireFromWatch(candidateId);
        repo.audit(
          this.db,
          'watch',
          attempt.ok ? 'watch hired into the roster' : `hire deferred: ${attempt.reason ?? 'unknown'}`,
          { candidateId, activationId: attempt.activationId ?? null },
        );
        if (attempt.ok) hired = candidateId;
      }
    }

    // A bench that missed its hire must not strand (D4: replacements within one
    // watch tick). While no chair is occupied at all, one promoted wallet is
    // retried each tick; plan 05 replaces this with roster-aware slot logic.
    if (hired === null && repo.activeActivationCount(this.db) === 0) {
      const bench = repo.listWatchWallets(this.db, 'promoted');
      const next = bench.find((w) => w.address.length > 0);
      if (next) {
        const attempt = await this.deps.lifecycle.hireFromWatch(next.candidateId);
        repo.audit(
          this.db,
          'watch',
          attempt.ok
            ? 'watch hired into the roster (bench retry)'
            : `bench retry deferred: ${attempt.reason ?? 'unknown'}`,
          { candidateId: next.candidateId, activationId: attempt.activationId ?? null },
        );
        if (attempt.ok) hired = next.candidateId;
      }
    }

    if (admitted + promoted + demoted + archived > 0) this.deps.onStateChanged();
    return { admitted, promoted, hired, demoted, archived };
  }

  /** The live inputs of a wallet's own promotion gates (no chair count). */
  private recordInput(candidateId: string) {
    return {
      aggregates: repo.shadowAggregates(this.db, candidateId),
      lastFundedBuyAt: repo.lastFundedBuyAt(this.db, candidateId),
      lastFiredAt: repo.lastFiredAt(this.db, candidateId),
      nowMs: Date.now(),
      config: {
        promotionMinClosed: this.risk.PROMOTION_MIN_CLOSED,
        promotionMinNetUsdMicro: usdToMicro(this.risk.PROMOTION_MIN_NET_USD),
        promotionMaxLastBuyHours: this.risk.PROMOTION_MAX_LAST_BUY_HOURS,
      },
    };
  }

  /** The D4 gate: the wallet's shadow record and a free chair. Capital is not a gate. */
  promotionDecision(candidateId: string): { ok: boolean; reason: PromotionBlockReason | null } {
    return canPromote({
      ...this.recordInput(candidateId),
      slotsFree: Math.max(0, this.risk.ROSTER_SIZE - repo.activeActivationCount(this.db)),
    });
  }

  /**
   * Cooling rotation: a fired trader returns only on a funded buy observed
   * after the fire; without one he is archived after the eviction window.
   */
  async coolingTick(): Promise<number> {
    let readmitted = 0;
    for (const wallet of repo.listWatchWallets(this.db, 'cooling')) {
      const firedAt = repo.lastFiredAt(this.db, wallet.candidateId);
      const lastBuy = repo.lastFundedBuyAt(this.db, wallet.candidateId);
      if (canReenter({ lastFiredAt: firedAt, lastFundedBuyAt: lastBuy })) {
        repo.setWatchStatus(this.db, wallet.candidateId, 'watching', 'funded buy observed after the firing');
        repo.audit(this.db, 'watch', 're-entry observed: funded buy after the firing', {
          candidateId: wallet.candidateId,
          lastFiredAt: firedAt,
          lastFundedBuyAt: lastBuy,
        });
        readmitted++;
        continue;
      }
      if (lastBuy === null && firedAt !== null) {
        const quietDays = (Date.now() - Date.parse(firedAt)) / (24 * 3_600_000);
        if (quietDays >= this.risk.WATCH_EVICTION_DAYS) {
          repo.setWatchStatus(this.db, wallet.candidateId, 'archived', 'no funded buy since the firing');
          repo.audit(this.db, 'watch', 'watch archived: no funded buy since the firing', {
            candidateId: wallet.candidateId,
            lastFiredAt: firedAt,
          });
        }
      }
    }
    if (readmitted > 0) this.deps.onStateChanged();
    return readmitted;
  }

  /** Manual promotion from the Watchlist panel. */
  async promoteNow(candidateId: string): Promise<{ ok: boolean; reason: string }> {
    const decision = this.promotionDecision(candidateId);
    if (!decision.ok) return { ok: false, reason: decision.reason ?? 'BLOCKED' };
    repo.setWatchStatus(this.db, candidateId, 'promoted', 'promoted from the dashboard');
    repo.audit(this.db, 'watch', 'watch promoted from the dashboard', { candidateId });
    const attempt = await this.deps.lifecycle.hireFromWatch(candidateId);
    repo.audit(
      this.db,
      'watch',
      attempt.ok ? 'watch hired into the roster' : `hire deferred: ${attempt.reason ?? 'unknown'}`,
      { candidateId, activationId: attempt.activationId ?? null },
    );
    this.deps.onStateChanged();
    return { ok: true, reason: attempt.ok ? 'HIRED' : 'PROMOTED' };
  }
}
