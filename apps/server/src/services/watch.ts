import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  canPromote,
  canReenter,
  dayTradeExitDecision,
  classifyFundedSwap,
  computeCopyNotional,
  usdToMicro,
  MinuteCeiling,
  signaturesAfterCursor,
  WATCH_DETAIL_PER_MINUTE,
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
 * the bench evidence — the fomo PnL mark is never an input.
 *
 * Everything is fail-closed: an unreadable transaction, an unpriceable mint or
 * a missing quote never invents a fill, a price, a notional or a bench seat.
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
  benched: number;
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

/** How many new transactions one watch poll inspects per wallet. */
const WATCH_TX_SCAN_LIMIT = 25;
/** Candidates scanned for admission per tick (bounded spend). */
export const ADMISSION_SCAN_PER_TICK = 3;
/** A candidate measured inside this window is not read again on the next tick. */
const ADMISSION_RESCAN_MS = 30 * 60_000;
/** Admission needs the whole 24h window, not just the newest page. */
const ADMISSION_SIGNATURE_PAGE = 100;
const ADMISSION_MAX_PAGES = 3;
const ADMISSION_MAX_DETAILS = 100;

/** Public detail failed and the Helius fallback is over its minute ceiling. Retry next tick. */
class DetailDeferred extends Error {
  constructor() {
    super('watch detail deferred (minute ceiling)');
    this.name = 'DetailDeferred';
  }
}

/** The scan cannot prove it covered the full lookback window; retry, never record zeros. */
class AdmissionScanIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionScanIncomplete';
  }
}
/** Admission reads look back 24h (D4's window). */
const ADMISSION_LOOKBACK_HOURS = 24;

export class WatchService {
  private detailCeiling = new MinuteCeiling(WATCH_DETAIL_PER_MINUTE);

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

  /**
   * Strict page used only by admission. Public failure falls back to Helius;
   * a Helius failure throws instead of returning [] (the tolerant
   * `recentSignatures` method would hide an outage as an empty wallet).
   */
  private async signaturePageStrict(
    address: string,
    limit: number,
    before?: string,
  ): Promise<Array<{ signature: string; blockTime: number | null }>> {
    if (this.deps.publicSolana.configured) {
      try {
        const rows = await this.deps.publicSolana.recentSignatures(address, limit, before);
        return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
      } catch {
        // Public node unavailable: the strict paid fallback below answers or throws.
      }
    }
    const rows = await this.deps.helius.recentSignaturesStrict(address, limit, before);
    return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
  }

  private async txSummary(address: string, signature: string) {
    if (this.deps.publicSolana.configured) {
      try {
        // Null is an answer: the node read the transaction and it was not this
        // signer, or it had nothing to classify. Paying Helius to repeat that
        // read is what pushed a quiet day to ~12k credits.
        return await this.deps.publicSolana.transactionSummary(address, signature);
      } catch {
        if (!this.detailCeiling.allow(Date.now())) throw new DetailDeferred();
      }
    }
    // A Helius error is a failed read, not "no swap". Let it reach the caller so
    // the admission scan can mark the check failed and keep the previous reading.
    return this.deps.helius.transactionSummary(address, signature, 'watch');
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

    const already = repo.listWatchWallets(this.db, 'watching').some((row) => row.candidateId === candidateId);
    if (!already && repo.listWatchWallets(this.db, 'watching').length >= risk.WATCH_LIST_SIZE) {
      throw new Error(`watch list is full (${risk.WATCH_LIST_SIZE})`);
    }

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

  /**
   * Scan one wallet for funded swaps over the lookback window.
   *
   * Throws when the signature page or any transaction detail read fails, or
   * when the bounded page/detail caps cannot prove the whole lookback window
   * was read: a partial scan must never be recorded as an `ok` reading. A
   * successful read with no funded swaps returns an empty reading (and
   * advances the queue). The caller (`evaluate`) marks a thrown scan failed
   * and preserves the last good columns; the unchanged `activity_checked_at`
   * keeps this candidate first in line for the next tick.
   */
  async scanWallet(address: string, lookbackHours = ADMISSION_LOOKBACK_HOURS): Promise<AdmissionReading> {
    const measuredAt = new Date().toISOString();
    const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;

    // Page backwards until the 24h cutoff (bounded). A full page whose oldest
    // row is still inside the window does not prove coverage.
    const rows: Array<{ signature: string; blockTime: number | null }> = [];
    let before: string | undefined;
    let covered = false;
    for (let page = 0; page < ADMISSION_MAX_PAGES; page++) {
      const batch = await this.signaturePageStrict(address, ADMISSION_SIGNATURE_PAGE, before);
      if (batch.length === 0) {
        covered = true;
        break;
      }
      rows.push(...batch);
      const oldest = batch[batch.length - 1]!;
      if (batch.length < ADMISSION_SIGNATURE_PAGE) {
        covered = true;
        break;
      }
      if (oldest.blockTime !== null && oldest.blockTime < cutoffSec) {
        covered = true;
        break;
      }
      before = oldest.signature;
    }
    if (!covered) {
      throw new AdmissionScanIncomplete(
        `signature page still inside the ${lookbackHours}h window after ${ADMISSION_MAX_PAGES} pages`,
      );
    }

    const inWindow = rows.filter((r) => r.blockTime !== null && r.blockTime >= cutoffSec);
    if (inWindow.length > ADMISSION_MAX_DETAILS) {
      throw new AdmissionScanIncomplete(
        `${inWindow.length} in-window signatures exceed the ${ADMISSION_MAX_DETAILS}-detail admission cap`,
      );
    }

    const events: FundedSwap[] = [];
    for (const row of inWindow) {
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
      const decision = dayTradeExitDecision({
        openedAtIso: lot.openedAt,
        nowMs: Date.now(),
        maxAgeHours: this.risk.MAX_POSITION_AGE_HOURS,
        graceHours: this.risk.POSITION_GRACE_HOURS,
        entryUsdMicro: entry,
        markUsdMicro: mark,
        peakUsdMicro: mark,
        lowSinceMaxHoldUsdMicro: null,
        stopLossBps: this.risk.STOP_LOSS_BPS,
        trailArmBps: this.risk.TRAIL_ARM_BPS,
        trailDistanceBps: this.risk.TRAIL_DISTANCE_BPS,
        partialTpBps: 0,
        partialTaken: false,
        graceBounceBps: this.risk.GRACE_BOUNCE_BPS,
        sellOnGreen: this.risk.SELL_ON_GREEN,
      });
      if (decision === 'none' || decision === 'partial_take_profit' || mark === null) continue;
      const notional = BigInt(lot.notionalUsdMicro);
      const pnl = shadowPnlUsdMicro(notional, entry, mark);
      repo.closeShadowTrade(this.db, lot.id, {
        closedAt: new Date().toISOString(),
        exitReason: decision,
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
      benched: 0,
      hired: null,
      demoted: 0,
      archived: 0,
      errors: [],
    };

    result.ceilingsClosed = await this.closeDueCeilings();

    // Watching only. Hired seats are covered by the roster stream and its
    // safety poll, so this pass does not pay for them a second time. Bench
    // rows keep the record they already earned; a fresh check is the hire path.
    for (const wallet of repo.listWatchWallets(this.db, 'watching')) {
      try {
        result.newEvents += await this.pollWallet(wallet.candidateId, wallet.address);
        result.polled++;
      } catch (e) {
        result.errors.push(`${wallet.candidateId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const evaluation = await this.evaluate();
    result.admitted = evaluation.admitted;
    result.benched = evaluation.benched;
    result.hired = evaluation.hired;
    result.demoted = evaluation.demoted;
    result.archived = evaluation.archived;
    return result;
  }

  /** Read new signatures for one watched wallet and apply its funded swaps. */
  private async pollWallet(candidateId: string, address: string): Promise<number> {
    const cursor = repo.getWatchCursor(this.db, address);
    const rows = await this.signaturePage(address, WATCH_TX_SCAN_LIMIT);
    const fresh = signaturesAfterCursor(rows, cursor?.lastSignature);
    if (fresh.length === 0) return 0;

    // Newest-first from the RPC; apply oldest-first so FIFO stays honest.
    // A deferred detail stops the cursor in front of that signature so the
    // next tick retries it instead of paying for the whole page again.
    let applied = 0;
    let advancedTo = cursor?.lastSignature ?? '';
    for (const row of [...fresh].reverse()) {
      let summary;
      try {
        summary = await this.txSummary(address, row.signature);
      } catch (error) {
        if (error instanceof DetailDeferred) break;
        throw error;
      }
      advancedTo = row.signature;
      if (!summary) continue;
      const swap = classifyFundedSwap(summary);
      if (swap && (await this.applyFundedSwap(candidateId, address, swap))) applied++;
    }
    if (advancedTo && advancedTo !== cursor?.lastSignature) {
      repo.setWatchCursor(this.db, {
        address,
        candidateId,
        lastSignature: advancedTo,
        lastSlot: cursor?.lastSlot ?? 0,
        lastTransactionIndex: 0,
      });
    }
    return applied;
  }

  /**
   * Admission scan (bounded per tick), demotion/eviction, then promotion.
   */
  async evaluate(): Promise<{
    admitted: number;
    benched: number;
    hired: string | null;
    demoted: number;
    archived: number;
  }> {
    let admitted = 0;
    let benched = 0;
    let hired: string | null = null;
    let demoted = 0;
    let archived = 0;

    // --- admission: candidates with a wallet that are not already on the list ---
    // The list is ordered least-recently-measured first (never-measured ahead of
    // everything), so the bounded scan advances through the pool.
    //
    // Failure policy: a successful read (including a genuinely empty wallet)
    // records the reading and moves the candidate to the back of the queue. A
    // failed or incomplete read records NOTHING as ok. Transient failures keep
    // the candidate first in line for the next tick; a deterministic overflow
    // / coverage cap gets a 30-minute scan deferral so it cannot occupy a slot
    // every tick. Both preserve the last good activity columns and their true
    // freshness.
    const candidates = repo.listAdmissionScanCandidates(this.db, ADMISSION_SCAN_PER_TICK);
    for (const candidate of candidates) {
      const checkedAt = candidate.activityCheckedAt ? Date.parse(candidate.activityCheckedAt) : null;
      if (checkedAt !== null && Date.now() - checkedAt < ADMISSION_RESCAN_MS) continue;
      const address = repo
        .listCandidateAddresses(this.db, candidate.candidateId)
        .find((a) => a.chain === 'solana')?.address;
      if (!address) continue;
      let reading: AdmissionReading;
      try {
        reading = await this.scanWallet(address);
      } catch (e) {
        const failedAt = new Date().toISOString();
        const deferred = e instanceof AdmissionScanIncomplete;
        const deferredUntil = deferred ? new Date(Date.now() + ADMISSION_RESCAN_MS).toISOString() : null;
        if (deferredUntil !== null) {
          repo.deferCandidateActivity(this.db, candidate.candidateId, deferredUntil, failedAt);
        } else {
          repo.markCandidateActivityFailed(this.db, candidate.candidateId, failedAt);
        }
        repo.audit(
          this.db,
          'watch',
          `admission scan failed for ${candidate.handle} (fail closed): ${
            e instanceof Error ? e.message : e
          }`,
          {
            candidateId: candidate.candidateId,
            address,
            ...(deferredUntil === null ? {} : { deferredUntil }),
          },
        );
        continue;
      }
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
      try {
        const verdict = await this.admit(candidate.candidateId, reading);
        if (verdict.ok) admitted++;
      } catch (e) {
        // The reading itself was good; a seat-side failure must not be recorded
        // as a failed activity check.
        repo.audit(
          this.db,
          'watch',
          `admission failed for ${candidate.handle}: ${e instanceof Error ? e.message : e}`,
          { candidateId: candidate.candidateId, address },
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
    // The bench is not a permanent seat. A wallet whose record no longer
    // qualifies (net fell, last buy went stale, or it was fired and has not
    // bought since) leaves the bench: back to the watch list, or archived when
    // the sample is full and negative. Without this a stale bench row could be
    // hired the moment a chair frees.
    for (const wallet of repo.listWatchWallets(this.db, 'bench')) {
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
      const record = this.promotionDecision(wallet.candidateId);
      if (!record.ok) {
        repo.setWatchStatus(this.db, wallet.candidateId, 'watching', `bench demoted: ${record.reason}`);
        repo.audit(this.db, 'watch', `bench demoted: ${record.reason}`, {
          candidateId: wallet.candidateId,
        });
        demoted++;
      }
    }

    // --- bench ---------------------------------------------------------------
    // Every wallet whose record qualifies joins the bench; no chair is needed.
    // The bench pre-builds while the roster is full — it is the ordered queue
    // (best shadow net first, the order fillRoster hires in) that a freed chair
    // is filled from.
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
      if (!block.ok) continue; // the record moved between checks
      repo.setWatchStatus(this.db, candidateId, 'bench', 'bench: record passes');
      repo.audit(this.db, 'watch', 'benched: record passes', { candidateId });
      benched++;
    }

    // Any free chair is filled from the bench now (best shadow net first), so
    // a seat that opened since the last sweep does not wait for one.
    if (repo.activeActivationCount(this.db) < this.risk.ROSTER_SIZE) {
      const filled = await this.deps.lifecycle.fillRoster().catch((e: Error) => {
        repo.audit(this.db, 'watch', `bench fill failed (fail closed): ${e.message}`, {});
        return { hired: [] as string[], reason: 'error' };
      });
      for (const candidateId of filled.hired) {
        repo.audit(this.db, 'watch', 'watch hired into the roster', { candidateId });
      }
      if (filled.hired.length > 0) hired = filled.hired[0]!;
    }

    if (admitted + benched + demoted + archived > 0) this.deps.onStateChanged();
    return { admitted, benched, hired, demoted, archived };
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
        cooldownHours: this.risk.COOLDOWN_HOURS,
      },
    };
  }

  /** The bench gate: the wallet's shadow record. A chair is the hire's concern. */
  promotionDecision(candidateId: string): { ok: boolean; reason: PromotionBlockReason | null } {
    return canPromote(this.recordInput(candidateId));
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
      if (
        canReenter({
          lastFiredAt: firedAt,
          lastFundedBuyAt: lastBuy,
          nowMs: Date.now(),
          cooldownHours: this.risk.COOLDOWN_HOURS,
        })
      ) {
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
    repo.setWatchStatus(this.db, candidateId, 'bench', 'added to the bench from the dashboard');
    repo.audit(this.db, 'watch', 'benched from the dashboard', { candidateId });
    // A free chair seats him right away; otherwise he waits on the bench in
    // net order like every other bench wallet.
    const attempt = await this.deps.lifecycle.hireFromWatch(candidateId);
    repo.audit(
      this.db,
      'watch',
      attempt.ok ? 'watch hired into the roster' : `hire deferred: ${attempt.reason ?? 'unknown'}`,
      { candidateId, activationId: attempt.activationId ?? null },
    );
    this.deps.onStateChanged();
    return { ok: true, reason: attempt.ok ? 'HIRED' : 'BENCHED' };
  }
}
