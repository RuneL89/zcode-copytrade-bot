import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  canPromote,
  canReenter,
  dayTradeExitDecision,
  GovernedSpendError,
  unpriceableShadowExitDecision,
  SHADOW_UNPRICEABLE_BACKSTOP_HOURS,
  classifyFundedSwap,
  computeCopyNotional,
  usdToMicro,
  MinuteCeiling,
  signaturesAfterCursor,
  type FundedSwap,
  type PromotionBlockReason,
  type ShadowPriceFailure,
} from '@zcode-bot/core';
import {
  PriceUnavailableError,
  type HeliusProvider,
  type PriceProvider,
  type PublicSolanaProvider,
} from '@zcode-bot/providers';
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

/**
 * Fixed ruler for the shadow ledger. The real copier's per-trade cap is a
 * percentage of current capital, but the shadow record must stay comparable
 * across bankroll growth: PROMOTION_MIN_NET_USD is a dollar threshold measured
 * on this $10 ceiling, so the ruler does not follow capital.
 */
export const SHADOW_REFERENCE_MAX_USD_MICRO = 10_000_000n;

/** Sizing helper: the D1 clamp on the leader's input notional (fixed shadow ruler). */
export function shadowNotionalUsdMicro(leaderInputUsdMicro: bigint, risk: RiskConfig): bigint | null {
  const minPerBuyUsdMicro = usdToMicro(risk.MIN_PER_BUY_USD);
  const maxPerBuyUsdMicro =
    minPerBuyUsdMicro > SHADOW_REFERENCE_MAX_USD_MICRO ? minPerBuyUsdMicro : SHADOW_REFERENCE_MAX_USD_MICRO;
  const sizing = computeCopyNotional({
    leaderInputUsdMicro,
    scaleNumerator: BigInt(Math.round(risk.COPY_SCALE * 10000)),
    scaleDenominator: 10000n,
    minPerBuyUsdMicro,
    maxPerBuyUsdMicro,
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

/**
 * The funded-buy reading admission is decided from.
 *
 * `partial` means the scan could not detail the whole 24h window (a busy
 * wallet, or more than three signature pages) and instead read a bounded
 * newest prefix. The buys/last-buy fields are a lower bound, never a census;
 * `admit` may still use them to prove the D4 gate, and the caller records the
 * reading as `partial` instead of `ok`.
 */
export interface AdmissionReading {
  /** Funded buys in the lookback (D4 definition); a lower bound when partial. */
  fundedBuys24h: number;
  /** Newest funded buy, ISO; null when there is none. */
  lastFundedBuyAt: string | null;
  /** When this reading was measured (freshness gate). */
  measuredAt: string;
  /** True when only a bounded prefix of the window was detailed. */
  partial: boolean;
  /** The scan's funded events, oldest first — used for the optional backfill. */
  events: FundedSwap[];
  /** Newest on-chain signature the scan saw, whatever its age; null for an empty wallet. */
  tip: string | null;
  /** True when the credit governor cut the scan short: the counts are a lower bound. */
  budgetExhausted: boolean;
  /**
   * Set instead of a reading when the wallet's newest signature is the one a
   * previous, completed scan already saw while finding it below the gate.
   * Nothing can have improved, so no read was paid for.
   */
  unchangedSince?: { buys: number };
  /**
   * Why each detail read resolved the way it did. A wallet whose every
   * readable transaction is a third-party affair with no balances of its own
   * (platform-style trading account) can never be proven — this is how the
   * audit and the dashboard say so instead of "did not prove N funded buys".
   */
  evidence: {
    inWindow: number;
    /** Detail reads attempted (RPC answers, readable or not). */
    detailed: number;
    /** Reads the node could not answer (null transaction). */
    unreadable: number;
    /** Readable transactions the wallet signed. */
    selfSigned: number;
    /** Readable transactions that only moved balances the wallet owns. */
    ownedDeltas: number;
    /** Readable transactions that are not the wallet's party at all. */
    noParty: number;
  };
}

export interface WatchTickResult {
  polled: number;
  newEvents: number;
  ceilingsClosed: number;
  readmitted: number;
  admitted: number;
  benched: number;
  hired: string | null;
  demoted: number;
  archived: number;
  /** Watching wallets whose slot went back to the admission queue (stale, no open lot). */
  released: number;
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
/**
 * Watch-list detail reads are public-RPC first. Helius is a bounded safety
 * valve only for wallets with an open shadow position or a funded buy inside
 * the recent-buy window; idle watchers wait for the next public read.
 */
export const WATCH_LIST_FALLBACK_PER_MINUTE = 15;
const WATCH_LIST_FALLBACK_RECENT_BUY_MS = 60 * 60_000;
/** Candidates scanned for admission per tick (bounded spend). */
export const ADMISSION_SCAN_PER_TICK = 1;
/** A candidate measured inside this window is not read again on the next tick. */
const ADMISSION_RESCAN_MS = 30 * 60_000;
/** Admission needs the whole 24h window, not just the newest page. */
const ADMISSION_SIGNATURE_PAGE = 100;
const ADMISSION_MAX_PAGES = 3;
/**
 * Detail reads admitted per admission pass. A window with more signatures is
 * read through its newest 12 first and marked `partial`: admission only has to
 * prove the funded-buy gate, not census the whole day. The cap keeps one tick
 * from spending a full busy wallet's history.
 */
export const ADMISSION_DETAILS_PER_TICK = 12;
/**
 * Detail reads every scan gets before any gating: a window this small is a
 * complete census; beyond it the scan is deepening and must show progress
 * (at least one attributed funded buy) to keep spending. A wallet whose buys
 * all sit deeper than this without one in the base window is not chased —
 * the defer ladder retries it, and the platform-style exit below stops
 * unattributable wallets at the same depth.
 */
export const ADMISSION_BASE_DETAILS_PER_SCAN = 24;
/**
 * The absolute ceiling of one admission scan: the base 24 deepen in 12-detail
 * batches up to this many reads while the scan keeps finding attributed buys,
 * stopping the moment the gate is proven. A hyperactive wallet whose newest
 * signatures mix buys and sells (1 buy in the base 24, 40+ across the day) is
 * otherwise deferred forever despite being the best candidate on the board.
 */
export const ADMISSION_MAX_DETAILS_PER_SCAN = 60;
/** A transient detail-budget miss leaves the queue for this long, so it cannot starve peers. */
const ADMISSION_TRANSIENT_DEFER_MS = 10 * 60_000;
/**
 * A scan that cannot prove the gate backs off longer each time: 30 min, 2h,
 * 8h, then 24h. After a deepened scan, an unproven wallet is either genuinely
 * below the bar or its activity is unattributable — either way it must not
 * hold the one admission slot every 30 minutes forever. A recorded reading
 * (ok census or proven partial) resets the ladder.
 */
const ADMISSION_DEFER_LADDER_MS = [30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
/**
 * A failed read (transport, HTTP, a Helius error) backs the candidate off like
 * this, so one wallet's persistent error cannot hold the only admission slot.
 * A single blip costs ten minutes; repeats escalate.
 */
const ADMISSION_ERROR_LADDER_MS = [10 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
/**
 * Deepening stops after this many consecutive reads without a new funded buy:
 * past the base window the scan continues only while buys keep appearing.
 */
const ADMISSION_DRY_READS_STOP = ADMISSION_BASE_DETAILS_PER_SCAN;
/**
 * When the credit governor refuses an admission read (the pre-hire budget for
 * the day is spent, or the ladder paused it) no candidate can be scanned, so
 * the whole admission scan rests this long before probing again instead of
 * spending a tick per candidate to be told the same thing.
 */
const ADMISSION_SUSPEND_MS = 15 * 60_000;

/** The wait for the n-th consecutive miss (1-based); the last step repeats. */
function ladderDefer(ladder: readonly number[], attempts: number): number {
  return ladder[Math.min(Math.max(attempts, 1) - 1, ladder.length - 1)]!;
}

/** The detail budget is spent or the public reader failed; retry next tick. */
class DetailDeferred extends Error {
  constructor(message = 'watch detail deferred') {
    super(message);
    this.name = 'DetailDeferred';
  }
}
/** Admission reads look back 24h (D4's window). */
const ADMISSION_LOOKBACK_HOURS = 24;

export class WatchService {
  /** Admission details left in this evaluate() pass (shared across scans). */
  private admissionDetailsRemaining = 0;
  /** Admission scanning rests until this instant after the credit governor refuses a read. */
  private admissionSuspendedUntil = 0;
  /** True while "the watch list is full" has been audited, so it is audited once, not per tick. */
  private admissionFullNoted = false;
  private readonly watchListDetailCeiling: MinuteCeiling;

  constructor(private deps: WatchServiceDeps) {
    this.watchListDetailCeiling = new MinuteCeiling(
      Math.min(WATCH_LIST_FALLBACK_PER_MINUTE, deps.risk.WATCH_DETAIL_PER_MINUTE),
    );
  }

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
    heliusPath: 'watch' | 'vetting' = 'watch',
  ): Promise<Array<{ signature: string; blockTime: number | null }>> {
    if (this.deps.publicSolana.configured) {
      try {
        const rows = await this.deps.publicSolana.recentSignatures(address, limit, before);
        return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
      } catch {
        // Public node unavailable: the strict paid fallback below answers or throws.
      }
    }
    const rows = await this.deps.helius.recentSignaturesStrict(address, limit, before, heliusPath);
    return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime }));
  }

  /**
   * Watch-list detail read. Public RPC is the default. Helius is allowed only
   * when the wallet has exposure (open shadow position or recent funded buy)
   * and only inside the small watch-list safety budget; everyone else waits
   * for the next public read. With no public provider configured, Helius is
   * the only detail source and remains bounded by the same safety budget.
   */
  private async txSummary(address: string, signature: string, allowHeliusFallback: boolean) {
    if (this.deps.publicSolana.configured) {
      try {
        // Null is an answer: the node read the transaction and it was not this
        // signer, or it had nothing to classify. Paying Helius to repeat that
        // read is what pushed a quiet day to ~12k credits.
        return await this.deps.publicSolana.transactionSummary(address, signature);
      } catch {
        if (!allowHeliusFallback) {
          throw new DetailDeferred('watch detail public RPC failed; retry next tick');
        }
      }
    }
    if (!this.watchListDetailCeiling.allow(Date.now())) {
      throw new DetailDeferred('watch-list Helius fallback budget spent');
    }
    try {
      return await this.deps.helius.transactionSummary(address, signature, 'watch');
    } catch {
      throw new DetailDeferred('watch-list Helius detail failed; retry next tick');
    }
  }

  /**
   * Admission detail read: the paid reader directly, bounded by the per-pass
   * budget. Returns who acted in the transaction — the summary, the fact the
   * wallet only owned the moved balances (bot execution), that it was no
   * party at all (platform-style account), or that the node could not answer.
   *
   * Paid from the `vetting` path, NOT `watch`: admission is pre-hire vetting,
   * it has no per-wallet ceiling there, and its spend can neither drain the
   * watch-list fallback's bucket nor trip the amber rule that pauses it. A
   * refusal throws `GovernedSpendError`; `scanWallet` decides what it means.
   */
  private async admissionTxParty(address: string, signature: string) {
    if (this.admissionDetailsRemaining <= 0) {
      throw new DetailDeferred('watch detail deferred (admission budget)');
    }
    this.admissionDetailsRemaining -= 1;
    return this.deps.helius.transactionParty(address, signature, 'vetting');
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
      // they are real on-chain trades, replayed oldest-first. The events and
      // lots are marked `backfill`/`backfilled`: they are ledger evidence, not
      // forward performance, so the promotion/demotion gates ignore them.
      for (const event of reading.events) {
        if (await this.applyFundedSwap(candidateId, address, event, { backfilled: true })) backfilled++;
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
        partial: reading.partial,
        backfilled,
      },
    );
    this.deps.onStateChanged();
    return { ok: true, reason: 'ADMITTED' };
  }

  /**
   * Scan one wallet for funded swaps over the lookback window.
   *
   * A window with at most ADMISSION_DETAILS_PER_TICK in-window signatures is
   * detailed in full and recorded as a complete (`ok`) reading. A busier
   * wallet — including one whose history does not fit in three signature pages
   * — gets a bounded newest prefix instead. The base window (the newest
   * `ADMISSION_BASE_DETAILS_PER_SCAN`) is always read; past it the scan
   * deepens only while the gate is still reachable at the base window's own
   * buy rate and buys keep appearing, up to `opts.maxDetails` reads, and stops
   * the moment the gate is proven. Admission only has to prove the funded-buy
   * gate, not census the whole day. That reading is marked `partial`; it is a
   * lower bound and is never stored as an `ok` census. A genuinely empty
   * wallet still returns an empty complete reading.
   *
   * Every paid call — a signature page when the public node cannot answer, and
   * every detail read — is charged to the `vetting` path: the pre-hire budget,
   * with no per-wallet ceiling, whose spend can neither drain nor pause the
   * watch-list fallback.
   *
   * When the credit governor refuses a read mid-scan, the scan keeps what it
   * already found and reports `budgetExhausted`. Refused before the first
   * read, the refusal is rethrown: nothing on the path can spend, and the
   * caller rests the whole admission scan. Every other failure — transport,
   * HTTP, the per-pass detail budget — always throws; the caller preserves the
   * last good columns and defers the candidate so the queue advances.
   *
   * With `opts.candidateId` the scan first compares the wallet's newest
   * signature with the tip a previous completed scan stored while finding the
   * wallet below the gate. An unchanged tip means nothing new happened
   * on-chain, so the reading cannot have improved: the scan returns
   * `unchangedSince` without paying for a single read.
   */
  async scanWallet(
    address: string,
    lookbackHours = ADMISSION_LOOKBACK_HOURS,
    opts: { proveBuys?: number; maxDetails?: number; candidateId?: string } = {},
  ): Promise<AdmissionReading> {
    const measuredAt = new Date().toISOString();
    const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;

    // Page backwards until the 24h cutoff (bounded). A full page whose oldest
    // row is still inside the window does not prove coverage; the rows we did
    // collect still support a bounded prefix decision.
    const rows: Array<{ signature: string; blockTime: number | null }> = [];
    let before: string | undefined;
    let covered = false;
    for (let page = 0; page < ADMISSION_MAX_PAGES; page++) {
      const batch = await this.signaturePageStrict(address, ADMISSION_SIGNATURE_PAGE, before, 'vetting');
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

    const tip = rows[0]?.signature ?? null;
    if (opts.candidateId && tip !== null) {
      const stored = this.storedTip(opts.candidateId);
      if (stored && stored.tip === tip) return this.unchangedReading(measuredAt, stored.buys);
    }

    const inWindow = rows.filter((r) => r.blockTime !== null && r.blockTime >= cutoffSec);
    const proveBuys = opts.proveBuys ?? Number.MAX_SAFE_INTEGER;
    const maxDetails = Math.max(ADMISSION_DETAILS_PER_TICK, opts.maxDetails ?? 0);
    const detailRows = inWindow.slice(0, maxDetails);

    const events: FundedSwap[] = [];
    const evidence: AdmissionReading['evidence'] = {
      inWindow: inWindow.length,
      detailed: 0,
      unreadable: 0,
      selfSigned: 0,
      ownedDeltas: 0,
      noParty: 0,
    };
    let buysSeen = 0;
    let detailed = 0;
    let dryReads = 0;
    let budgetExhausted = false;
    for (; detailed < detailRows.length; detailed++) {
      // Gate proven past the first batch: stop immediately — the reading is a
      // partial lower bound anyway, and the budget belongs to the rest of the
      // queue. Quiet wallets (a window that fits the first batch) always get
      // their complete census.
      if (detailed >= ADMISSION_DETAILS_PER_TICK && buysSeen >= proveBuys) {
        break;
      }
      // Past the base window, keep reading only while the gate is reachable at
      // the base window's own buy rate (buys so far, extrapolated over the
      // whole scan budget) and buys keep appearing. A wallet that cannot
      // reach the bar at that rate is not chased by depth — the defer ladder
      // re-reads it when it has traded again.
      if (detailed >= ADMISSION_BASE_DETAILS_PER_SCAN) {
        const reachable = buysSeen * maxDetails >= proveBuys * ADMISSION_BASE_DETAILS_PER_SCAN;
        if (!reachable || dryReads >= ADMISSION_DRY_READS_STOP) {
          break;
        }
      }
      // A platform-style account (every readable transaction third-party with
      // none of the wallet's own balances moving) can never prove the gate no
      // matter how deep the scan goes — stop spending the budget on it once
      // the pattern is established.
      if (
        detailed >= ADMISSION_DETAILS_PER_TICK &&
        evidence.detailed + evidence.noParty >= ADMISSION_DETAILS_PER_TICK * 2 &&
        evidence.selfSigned + evidence.ownedDeltas === 0
      ) {
        break;
      }
      const party = await this.admissionTxParty(address, detailRows[detailed]!.signature).catch(
        (e: unknown): null => {
          // The day's pre-hire budget (or the ladder) ended the scan: what the
          // reads so far found still holds as a lower bound. A 429 backoff is
          // a blip, not a budget: let it throw.
          if (e instanceof GovernedSpendError && e.decision.reason !== 'backoff' && detailed > 0) return null;
          throw e;
        },
      );
      if (party === null) {
        budgetExhausted = true;
        break;
      }
      dryReads++;
      if (party.kind === 'unreadable') {
        evidence.unreadable++;
        continue;
      }
      if (party.kind === 'no-party') {
        evidence.noParty++;
        continue;
      }
      evidence.detailed++;
      if (party.how === 'self-signed') evidence.selfSigned++;
      else evidence.ownedDeltas++;
      const swap = classifyFundedSwap(party.summary);
      if (swap) {
        events.push(swap);
        if (swap.side === 'buy' || swap.side === 'swap') {
          buysSeen++;
          dryReads = 0;
        }
      }
    }
    const partial = !covered || detailed < inWindow.length || budgetExhausted;
    events.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    const buys = events.filter((e) => e.side === 'buy' || e.side === 'swap');
    const newestBuy = buys[buys.length - 1] ?? null;
    return {
      fundedBuys24h: buys.length,
      lastFundedBuyAt:
        newestBuy && newestBuy.blockTime !== null ? new Date(newestBuy.blockTime * 1000).toISOString() : null,
      measuredAt,
      partial,
      events,
      tip,
      budgetExhausted,
      evidence,
    };
  }

  /** The tip a completed scan stored for a candidate it found below the gate. */
  private storedTip(candidateId: string): { tip: string; buys: number } | null {
    const raw = repo.kvGet(this.db, repo.admissionTipKey(candidateId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { tip?: unknown; buys?: unknown };
      return typeof parsed.tip === 'string' && typeof parsed.buys === 'number'
        ? { tip: parsed.tip, buys: parsed.buys }
        : null;
    } catch {
      return null; // an unparsable record never skips a scan
    }
  }

  private unchangedReading(measuredAt: string, buys: number): AdmissionReading {
    return {
      fundedBuys24h: buys,
      lastFundedBuyAt: null,
      measuredAt,
      partial: true,
      events: [],
      tip: null,
      budgetExhausted: false,
      unchangedSince: { buys },
      evidence: { inWindow: 0, detailed: 0, unreadable: 0, selfSigned: 0, ownedDeltas: 0, noParty: 0 },
    };
  }

  // ---- shadow ledger -------------------------------------------------------

  /**
   * Record one observed funded swap: idempotent event row, then the shadow
   * effect (open a lot on a buy, close FIFO on a sell). Returns true when the
   * event was new. `opts.backfilled` marks the admission replay: the lot is
   * still booked (with its real history and ceiling) but never counts toward
   * the forward-only promotion/demotion sample.
   */
  async applyFundedSwap(
    candidateId: string,
    address: string,
    swap: FundedSwap,
    opts: { backfilled?: boolean } = {},
  ): Promise<boolean> {
    const key = `${candidateId}|${swap.signature}|${swap.side}`;
    // The unique key in watch_events is the durable guarantee; this set also
    // blocks a double-apply inside one run while a slow price lookup is in
    // flight.
    if (this.seenShadowEvents.has(key)) return false;
    const observedAt = new Date().toISOString();
    const backfilled = opts.backfilled === true;
    const tokens = swap.tokenDeltaBase < 0n ? -swap.tokenDeltaBase : swap.tokenDeltaBase;
    const inserted = repo.insertWatchEvent(this.db, {
      candidateId,
      address,
      signature: swap.signature,
      // A rotation is an entry into the incoming coin (operator decision
      // 2026-11-22): the event row records it as the buy it economically is,
      // so the funded-buy recency clock and the dashboards see it.
      side: swap.side === 'swap' ? 'buy' : swap.side,
      mint: swap.mint,
      tokenAmountBase: tokens.toString(),
      decimals: swap.decimals,
      usdMicro: '0',
      blockTime: swap.blockTime ?? 0,
      observedAt,
      source: backfilled ? 'backfill' : 'watch-poll',
    });
    if (!inserted) return false;
    this.seenShadowEvents.add(key);

    if (swap.side === 'buy') await this.openShadowFromBuy(candidateId, swap, backfilled);
    else if (swap.side === 'sell') await this.closeShadowFromSell(candidateId, swap, observedAt);
    else await this.applySwapRotation(candidateId, swap, backfilled, observedAt);
    return true;
  }

  /** In-run dedupe so a slow price lookup cannot double-apply the same event. */
  private seenShadowEvents = new Set<string>();

  private async openShadowFromBuy(candidateId: string, swap: FundedSwap, backfilled: boolean): Promise<void> {
    const tokens = swap.tokenDeltaBase > 0n ? swap.tokenDeltaBase : -swap.tokenDeltaBase;
    if (tokens <= 0n) return;
    let inputUsdMicro: bigint | null = null;
    try {
      inputUsdMicro = await this.fundingUsdMicro(swap);
    } catch {
      inputUsdMicro = null; // unpriced: the event row stays, the shadow does not
    }
    if (inputUsdMicro === null) return;
    this.openLotAtValue(candidateId, swap, tokens, inputUsdMicro, backfilled);
  }

  /**
   * One shadow entry at a known USD value: the lot is priced at the LEADER's
   * per-coin price (what he paid); our notional only decides how much of the
   * pretend position we take (the D1 clamp).
   */
  private openLotAtValue(
    candidateId: string,
    swap: FundedSwap,
    tokens: bigint,
    inputUsdMicro: bigint,
    backfilled: boolean,
  ): void {
    const notional = shadowNotionalUsdMicro(inputUsdMicro, this.risk);
    if (notional === null) return;
    const scale = 10n ** BigInt(Math.max(0, swap.decimals));
    const entryPriceUsdMicro = (inputUsdMicro * scale) / tokens;
    if (entryPriceUsdMicro <= 0n) return;
    repo.openShadowTrade(this.db, {
      candidateId,
      mint: swap.mint,
      openedAt: new Date((swap.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      entryPriceUsdMicro: entryPriceUsdMicro.toString(),
      notionalUsdMicro: notional.toString(),
      backfilled,
    });
    repo.audit(this.db, 'watch', 'shadow opened at our notional (D1 clamp)', {
      candidateId,
      signature: swap.signature,
      mint: swap.mint,
      notionalUsdMicro: notional.toString(),
      entryPriceUsdMicro: entryPriceUsdMicro.toString(),
      backfilled,
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
    this.closeLotsFifo(candidateId, swap, soldTokens, exitPriceUsdMicro, closedAt);
  }

  /**
   * FIFO close of `soldTokens` base units of the swap's mint at
   * `exitPriceUsdMicro` (the leader's implied per-coin price). A partial sell
   * closes proportionally: the closed part becomes a row, the remainder stays
   * open with its original entry price and open time.
   */
  private closeLotsFifo(
    candidateId: string,
    swap: FundedSwap,
    soldTokens: bigint,
    exitPriceUsdMicro: bigint,
    closedAt: string,
  ): void {
    const scale = 10n ** BigInt(Math.max(0, swap.decimals));
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
          // The closed slice keeps the provenance of the lot it came from.
          backfilled: lot.backfilled,
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

  /**
   * Coin-for-coin rotation (operator decision 2026-11-22): the leader exited
   * `outMint` and entered `swap.mint` in one transaction. The shadow ruler
   * mirrors both legs at one price — the incoming coin's USD value at the
   * swap prices the exit of the outgoing lots AND the entry of the incoming
   * lot. An unpriceable incoming coin leaves the ledger untouched: the exit
   * waits for the ceiling clock, the entry for a priceable trade.
   */
  private async applySwapRotation(
    candidateId: string,
    swap: FundedSwap,
    backfilled: boolean,
    observedAt: string,
  ): Promise<void> {
    const inTokens = swap.tokenDeltaBase > 0n ? swap.tokenDeltaBase : -swap.tokenDeltaBase;
    if (inTokens <= 0n || !swap.outMint) return;
    let inValueUsdMicro: bigint | null = null;
    try {
      const price = await this.deps.prices.priceOf(swap.mint, swap.decimals);
      inValueUsdMicro = (inTokens * price.priceUsdMicro) / 10n ** BigInt(Math.max(0, swap.decimals));
    } catch {
      inValueUsdMicro = null; // no quote: never invent a notional
    }
    if (inValueUsdMicro === null || inValueUsdMicro <= 0n) return;

    const outTokens =
      swap.outTokenDeltaBase !== undefined
        ? swap.outTokenDeltaBase < 0n
          ? -swap.outTokenDeltaBase
          : swap.outTokenDeltaBase
        : 0n;
    if (outTokens > 0n) {
      const outScale = 10n ** BigInt(Math.max(0, swap.outDecimals ?? 0));
      const exitPriceUsdMicro = (inValueUsdMicro * outScale) / outTokens;
      if (exitPriceUsdMicro > 0n) {
        this.closeLotsFifo(
          candidateId,
          { ...swap, mint: swap.outMint, decimals: swap.outDecimals ?? 0 },
          outTokens,
          exitPriceUsdMicro,
          observedAt,
        );
      }
    }
    this.openLotAtValue(candidateId, swap, inTokens, inValueUsdMicro, backfilled);
  }

  /** Ceiling: MAX_POSITION_AGE_HOURS, + POSITION_GRACE_HOURS when the mark is not positive. */
  private async closeDueCeilings(): Promise<number> {
    let closed = 0;
    for (const lot of repo.listOpenShadowTrades(this.db)) {
      const now = Date.now();
      const decimals = this.decimalsFor(lot.candidateId, lot.mint);
      let mark: bigint | null = null;
      let priceFailure: ShadowPriceFailure = 'transient';
      if (decimals !== null) {
        try {
          mark = (await this.deps.prices.priceOf(lot.mint, decimals)).priceUsdMicro;
        } catch (e) {
          mark = null;
          priceFailure =
            e instanceof PriceUnavailableError && e.reason === 'no_route' ? 'no_route' : 'transient';
        }
      }
      const entry = BigInt(lot.entryPriceUsdMicro);
      const ageHours = (now - Date.parse(lot.openedAt)) / 3_600_000;
      const decision = dayTradeExitDecision({
        openedAtIso: lot.openedAt,
        nowMs: now,
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
      if (decision === 'none' || decision === 'partial_take_profit') continue;
      if (mark === null) {
        // The deadline passed but nothing could be priced. A confirmed Jupiter
        // no-route is terminal at the deadline; a transient failure (or missing
        // decimals) gets a 24h wall-clock backstop so an outage cannot zero lots.
        const terminal = unpriceableShadowExitDecision({
          openedAtIso: lot.openedAt,
          nowMs: now,
          maxAgeHours: this.risk.MAX_POSITION_AGE_HOURS,
          graceHours: this.risk.POSITION_GRACE_HOURS,
          failure: priceFailure,
        });
        if (terminal !== 'close_zero') continue;
        const notional = BigInt(lot.notionalUsdMicro);
        repo.closeShadowTrade(this.db, lot.id, {
          closedAt: new Date().toISOString(),
          exitReason: 'unpriceable',
          exitPriceUsdMicro: '0',
          pnlUsdMicro: (-notional).toString(),
        });
        repo.audit(
          this.db,
          'watch',
          priceFailure === 'no_route'
            ? 'shadow closed unpriceable at $0 (no Jupiter route)'
            : `shadow closed unpriceable at $0 (no quote after ${SHADOW_UNPRICEABLE_BACKSTOP_HOURS}h backstop)`,
          {
            candidateId: lot.candidateId,
            mint: lot.mint,
            openedAt: lot.openedAt,
            notionalUsdMicro: notional.toString(),
            failure: priceFailure,
            decimalsKnown: decimals !== null,
          },
        );
        closed++;
        continue;
      }
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
        `shadow exit ${decision} at $${(Number(mark) / 1e6).toFixed(6)} after ${ageHours.toFixed(1)}h` +
          ` (max ${this.risk.MAX_POSITION_AGE_HOURS}h, grace ${this.risk.POSITION_GRACE_HOURS}h)`,
        {
          candidateId: lot.candidateId,
          mint: lot.mint,
          openedAt: lot.openedAt,
          decision,
          ageHours: Number(ageHours.toFixed(1)),
        },
      );
      closed++;
    }
    if (closed > 0) this.deps.onStateChanged();
    return closed;
  }

  // ---- ticks ---------------------------------------------------------------

  /**
   * Re-admit cooling wallets whose re-entry block has lifted, poll every
   * watching wallet, apply new funded swaps, then evaluate.
   */
  async tick(): Promise<WatchTickResult> {
    const result: WatchTickResult = {
      polled: 0,
      newEvents: 0,
      ceilingsClosed: 0,
      readmitted: 0,
      admitted: 0,
      benched: 0,
      hired: null,
      demoted: 0,
      archived: 0,
      released: 0,
      errors: [],
    };

    result.ceilingsClosed = await this.closeDueCeilings();
    // Re-admit before polling so a wallet whose block just lifted is observed
    // in this same tick.
    result.readmitted = await this.coolingTick();

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
    result.released = evaluation.released;
    return result;
  }

  /** Open shadow exposure or a funded buy inside the safety-valve window. */
  private hasWatchExposure(candidateId: string): boolean {
    if (repo.listOpenShadowTrades(this.db, candidateId).length > 0) return true;
    const wallet = repo.getWatchWallet(this.db, candidateId);
    const lastBuyMs = wallet?.lastFundedBuyAt ? Date.parse(wallet.lastFundedBuyAt) : Number.NaN;
    return Number.isFinite(lastBuyMs) && Date.now() - lastBuyMs <= WATCH_LIST_FALLBACK_RECENT_BUY_MS;
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
    let allowHeliusFallback = this.hasWatchExposure(candidateId);
    for (const row of [...fresh].reverse()) {
      let summary;
      try {
        summary = await this.txSummary(address, row.signature, allowHeliusFallback);
      } catch (error) {
        if (error instanceof DetailDeferred) break;
        throw error;
      }
      advancedTo = row.signature;
      if (!summary) continue;
      const swap = classifyFundedSwap(summary);
      if (swap && (await this.applyFundedSwap(candidateId, address, swap))) {
        applied++;
        // A newly observed buy opens exposure, so later details this tick may
        // use the bounded safety valve if the public node keeps failing.
        if (swap.side === 'buy') allowHeliusFallback = true;
      }
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
   * Admission scan (bounded per tick), eviction/release/demotion, then
   * promotion.
   */
  async evaluate(): Promise<{
    admitted: number;
    benched: number;
    hired: string | null;
    demoted: number;
    archived: number;
    released: number;
  }> {
    let admitted = 0;
    let benched = 0;
    let hired: string | null = null;
    let demoted = 0;
    let archived = 0;
    let released = 0;

    // --- admission: candidates with a wallet that are not already on the list ---
    // The list is ordered least-recently-measured first (never-measured ahead of
    // everything), so the bounded scan advances through the pool. Freshness is
    // filtered before the SQL limit: with a one-candidate tick, a recently
    // checked head row must not consume the only slot.
    //
    // Failure policy: a complete read (including a genuinely empty wallet) is
    // recorded as `ok` and moves the candidate to the back of the queue. A
    // bounded prefix that PROVES the D4 gate is recorded as `partial` and
    // admitted. Anything below the gate — a truncated reading, a complete
    // window with too few buys, or a wallet unchanged since such a scan —
    // records what it may and waits on the defer ladder, so one candidate can
    // never hold the only slot. A scan that throws defers too: a refusal by
    // the credit governor rests the whole scan (no candidate can spend), a
    // brief miss waits ten minutes, any other error backs that candidate off
    // on its own ladder. Every failure path preserves the last good activity
    // columns and their true freshness.
    this.admissionDetailsRemaining = Math.min(
      Math.max(ADMISSION_DETAILS_PER_TICK, this.risk.ADMISSION_MAX_DETAILS_PER_SCAN),
      this.risk.WATCH_DETAIL_PER_MINUTE,
    );
    // Nothing can be admitted while the list is full, so a scan could only
    // spend pre-hire credits to be turned away. Resume as soon as a slot frees.
    const watchingCount = repo.listWatchWallets(this.db, 'watching').length;
    const listFull = watchingCount >= this.risk.WATCH_LIST_SIZE;
    if (listFull !== this.admissionFullNoted) {
      this.admissionFullNoted = listFull;
      repo.audit(
        this.db,
        'watch',
        listFull
          ? `admission idle: watch list is full (${watchingCount}/${this.risk.WATCH_LIST_SIZE}); scanning resumes when a slot frees`
          : `admission resumed: watch list has room (${watchingCount}/${this.risk.WATCH_LIST_SIZE})`,
        {},
      );
    }
    const minBuys = this.risk.ADMISSION_MIN_BUYS_24H;
    if (!listFull && Date.now() >= this.admissionSuspendedUntil) {
      const checkedBefore = new Date(Date.now() - ADMISSION_RESCAN_MS).toISOString();
      const candidates = repo.listAdmissionScanCandidates(this.db, ADMISSION_SCAN_PER_TICK, checkedBefore);
      for (const candidate of candidates) {
        const address = repo
          .listCandidateAddresses(this.db, candidate.candidateId)
          .find((a) => a.chain === 'solana')?.address;
        if (!address) continue;
        let reading: AdmissionReading;
        try {
          reading = await this.scanWallet(address, ADMISSION_LOOKBACK_HOURS, {
            proveBuys: minBuys,
            maxDetails: this.risk.ADMISSION_MAX_DETAILS_PER_SCAN,
            candidateId: candidate.candidateId,
          });
        } catch (e) {
          this.admissionScanFailed(candidate, address, e);
          continue;
        }
        if (reading.unchangedSince) {
          // The wallet has not moved since a completed scan already read it and
          // found it below the gate. Nothing can have improved, and no read was
          // paid for; it keeps waiting on the same ladder.
          const attempts = this.bumpAdmissionAttempts(candidate.candidateId);
          const deferMs = ladderDefer(ADMISSION_DEFER_LADDER_MS, attempts);
          const deferredUntil = new Date(Date.now() + deferMs).toISOString();
          repo.deferCandidateActivity(this.db, candidate.candidateId, deferredUntil, reading.measuredAt);
          repo.audit(
            this.db,
            'watch',
            `admission unchanged for ${candidate.handle}: no new transaction since the last scan ` +
              `(${reading.unchangedSince.buys} funded buys); deferred ${Math.round(deferMs / 60_000)} min (attempt ${attempts})`,
            { candidateId: candidate.candidateId, address, deferredUntil, attempts },
          );
          continue;
        }
        const belowGate = reading.fundedBuys24h < minBuys;
        if (belowGate && reading.partial) {
          // Never overwrite the last good census with a truncated reading.
          this.deferBelowGate(candidate, address, reading, 'prefix');
          continue;
        }
        const priorAttempts = this.admissionAttempts(candidate.candidateId);
        const newestEvent = reading.events[reading.events.length - 1] ?? null;
        repo.updateCandidateActivity(this.db, candidate.candidateId, {
          swaps24h: reading.events.length,
          lastSwapAt:
            newestEvent?.blockTime != null ? new Date(newestEvent.blockTime * 1000).toISOString() : null,
          lastBuyAt: reading.lastFundedBuyAt,
          buys24h: reading.fundedBuys24h,
          sells24h: reading.events.filter((e) => e.side === 'sell').length,
          status: reading.partial ? 'partial' : 'ok',
          checkedAt: reading.measuredAt,
        });
        if (belowGate && reading.fundedBuys24h > 0) {
          // A complete window with real buys but too few of them. The census
          // stands (it is a true reading of the day), and the wallet waits on
          // the ladder instead of being re-read every time it becomes the
          // oldest row of its tier. A quiet wallet (no buy at all) is simply
          // recorded and rejoins the pool's normal rotation.
          this.deferBelowGate(candidate, address, reading, 'complete window', priorAttempts);
          continue;
        }
        // At or above the gate: when a slot frees this reading has to be taken
        // again, so no stored tip may short-circuit the rescan.
        repo.kvDelete(this.db, repo.admissionTipKey(candidate.candidateId));
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
      const openLots = repo.listOpenShadowTrades(this.db, wallet.candidateId).length;
      // "Full sample" means the forward record is complete: K forward closes
      // with a negative net AND nothing still open. An open lot can flip the
      // record (cand_heat finished +$171.69 after an early archive), and the
      // archive is irreversible.
      if (
        aggregates.closedCount >= this.risk.PROMOTION_MIN_CLOSED &&
        aggregates.netPnlUsdMicro <= 0n &&
        openLots === 0
      ) {
        repo.setWatchStatus(
          this.db,
          wallet.candidateId,
          'archived',
          'negative forward shadow record with a full sample',
        );
        repo.audit(this.db, 'watch', 'watch demoted: negative forward shadow record with a full sample', {
          candidateId: wallet.candidateId,
          closedCount: aggregates.closedCount,
          netPnlUsdMicro: aggregates.netPnlUsdMicro.toString(),
        });
        demoted++;
        continue;
      }
      // Stale release: the list is a funnel cap, not a seat for life. A wallet
      // that has not bought for longer than admission's own freshness rule can
      // no longer be promoted and would no longer be admitted; with nothing
      // open there is nothing left to observe. It gives its slot back to the
      // queue. This is NOT the irreversible archive: the shadow record stays
      // and a later re-admission continues it.
      if (
        lastBuyMs !== null &&
        now - lastBuyMs >= this.risk.ADMISSION_MAX_LAST_BUY_HOURS * 3_600_000 &&
        openLots === 0
      ) {
        const quietHours = Math.round((now - lastBuyMs) / 3_600_000);
        repo.releaseWatchWallet(this.db, wallet.candidateId);
        repo.audit(
          this.db,
          'watch',
          `watch released: no funded buy for ${quietHours}h and nothing open; slot returned to the admission queue`,
          {
            candidateId: wallet.candidateId,
            lastFundedBuyAt: wallet.lastFundedBuyAt,
            closedCount: aggregates.closedCount,
            netPnlUsdMicro: aggregates.netPnlUsdMicro.toString(),
          },
        );
        released++;
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
      const openLots = repo.listOpenShadowTrades(this.db, wallet.candidateId).length;
      if (
        aggregates.closedCount >= this.risk.PROMOTION_MIN_CLOSED &&
        aggregates.netPnlUsdMicro <= 0n &&
        openLots === 0
      ) {
        repo.setWatchStatus(
          this.db,
          wallet.candidateId,
          'archived',
          'negative forward shadow record with a full sample',
        );
        repo.audit(this.db, 'watch', 'bench demoted: negative forward shadow record with a full sample', {
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
        repo.audit(this.db, 'watch', 're-entry blocked (waiting for another hire or the free-chair window)', {
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

    if (admitted + benched + demoted + archived + released > 0) this.deps.onStateChanged();
    return { admitted, benched, hired, demoted, archived, released };
  }

  /** The live inputs of a wallet's own promotion gates (no chair count). */
  private recordInput(candidateId: string) {
    const lastFiredAt = repo.lastFiredAt(this.db, candidateId);
    return {
      aggregates: repo.shadowAggregates(this.db, candidateId),
      lastFundedBuyAt: repo.lastFundedBuyAt(this.db, candidateId),
      lastFiredAt,
      nowMs: Date.now(),
      anotherHiredSinceFire: lastFiredAt !== null && repo.hasHireSince(this.db, lastFiredAt, candidateId),
      freeChair: repo.activeActivationCount(this.db) < this.risk.ROSTER_SIZE,
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

  /** Consecutive scans of this candidate that produced no usable admission. */
  private admissionAttempts(candidateId: string): number {
    const current = Number(repo.kvGet(this.db, repo.admissionAttemptsKey(candidateId)) ?? '0');
    return Number.isFinite(current) && current > 0 ? current : 0;
  }

  /**
   * One more consecutive scan without a usable admission (1-based). Drives the
   * defer ladders; `updateCandidateActivity` clears the counter when a real
   * reading is recorded.
   */
  private bumpAdmissionAttempts(candidateId: string): number {
    const attempts = this.admissionAttempts(candidateId) + 1;
    repo.kvSet(this.db, repo.admissionAttemptsKey(candidateId), String(attempts));
    return attempts;
  }

  /**
   * A scan that found the wallet below the funded-buy gate. The caller has
   * recorded a complete census already (`kind === 'complete window'`, and
   * `priorAttempts` is the ladder step that recording has just cleared); a
   * truncated reading records nothing as a census. Either way the wallet waits
   * on the defer ladder, and the on-chain tip is stored so an unchanged wallet
   * is not paid for again — unless the credit budget cut the scan short, in
   * which case a later full scan may still find more.
   */
  private deferBelowGate(
    candidate: { candidateId: string; handle: string },
    address: string,
    reading: AdmissionReading,
    kind: 'prefix' | 'complete window',
    priorAttempts?: number,
  ): void {
    const minBuys = this.risk.ADMISSION_MIN_BUYS_24H;
    const attempts =
      priorAttempts === undefined ? this.bumpAdmissionAttempts(candidate.candidateId) : priorAttempts + 1;
    const deferMs = ladderDefer(ADMISSION_DEFER_LADDER_MS, attempts);
    const deferredUntil = new Date(Date.now() + deferMs).toISOString();
    if (priorAttempts === undefined) {
      repo.deferCandidateActivity(this.db, candidate.candidateId, deferredUntil, reading.measuredAt);
    } else {
      // The census was recorded as `ok`; only the eligibility signal is written.
      repo.kvSet(this.db, repo.admissionAttemptsKey(candidate.candidateId), String(attempts));
      repo.kvSet(this.db, repo.admissionDeferKey(candidate.candidateId), deferredUntil);
    }
    if (!reading.budgetExhausted && reading.tip !== null) {
      repo.kvSet(
        this.db,
        repo.admissionTipKey(candidate.candidateId),
        JSON.stringify({ tip: reading.tip, buys: reading.fundedBuys24h }),
      );
    }
    const ev = reading.evidence;
    const readable = ev.detailed + ev.noParty;
    const verdict =
      ev.selfSigned + ev.ownedDeltas > 0
        ? 'attributed'
        : readable > 0
          ? `third-party-signed ${readable}/${readable} readable — no wallet-owned balances moved`
          : ev.unreadable > 0
            ? `unreadable ${ev.unreadable}/${ev.unreadable} read`
            : 'quiet';
    repo.audit(
      this.db,
      'watch',
      `admission ${kind} for ${candidate.handle} did not prove ` +
        `${minBuys} funded buys (${reading.fundedBuys24h} found); deferred ${Math.round(deferMs / 60_000)} min ` +
        `(attempt ${attempts}, ${verdict})${reading.budgetExhausted ? ' [cut by the credit budget]' : ''}`,
      {
        candidateId: candidate.candidateId,
        address,
        deferredUntil,
        attempts,
        evidence: ev,
        budgetExhausted: reading.budgetExhausted,
      },
    );
  }

  /**
   * A scan that threw. The last good activity columns always stay.
   *
   * A refusal by the credit governor — the pre-hire budget for the day is
   * spent, or the ladder paused the path — is not about this candidate:
   * nothing can be scanned, so the whole admission scan rests for a while and
   * the candidate stays first in line. The per-pass detail budget and a 429
   * backoff are brief: the candidate waits ten minutes. Any other error backs
   * the candidate off on its own ladder, so a wallet that fails every time
   * cannot hold the only admission slot.
   */
  private admissionScanFailed(
    candidate: { candidateId: string; handle: string },
    address: string,
    e: unknown,
  ): void {
    const failedAt = new Date().toISOString();
    const message = e instanceof Error ? e.message : String(e);
    const denial = e instanceof GovernedSpendError ? (e.decision.reason ?? 'unknown') : null;
    if (denial !== null && denial !== 'backoff') {
      this.admissionSuspendedUntil = Date.now() + ADMISSION_SUSPEND_MS;
      repo.markCandidateActivityFailed(this.db, candidate.candidateId, failedAt);
      repo.audit(
        this.db,
        'watch',
        `admission paused ${Math.round(ADMISSION_SUSPEND_MS / 60_000)} min: the credit governor refused a read ` +
          `for ${candidate.handle} (${message}); the candidate stays first in line`,
        {
          candidateId: candidate.candidateId,
          address,
          reason: denial,
          suspendedUntil: new Date(this.admissionSuspendedUntil).toISOString(),
        },
      );
      return;
    }
    const brief = denial === 'backoff' || e instanceof DetailDeferred;
    const attempts = brief ? null : this.bumpAdmissionAttempts(candidate.candidateId);
    const deferMs = brief ? ADMISSION_TRANSIENT_DEFER_MS : ladderDefer(ADMISSION_ERROR_LADDER_MS, attempts!);
    const deferredUntil = new Date(Date.now() + deferMs).toISOString();
    repo.deferCandidateActivity(this.db, candidate.candidateId, deferredUntil, failedAt);
    repo.audit(
      this.db,
      'watch',
      `admission scan failed for ${candidate.handle} (fail closed): ${message}` +
        (attempts === null ? '' : `; deferred ${Math.round(deferMs / 60_000)} min (attempt ${attempts})`),
      {
        candidateId: candidate.candidateId,
        address,
        deferredUntil,
        ...(attempts === null ? {} : { attempts }),
      },
    );
  }

  /**
   * Re-admission: a cooling wallet returns to the watch list when another
   * trader was hired after its firing, or when the re-entry window has elapsed
   * while a roster chair is free. The normal promotion gates then decide.
   */
  async coolingTick(): Promise<number> {
    let readmitted = 0;
    let watchingCount = repo.listWatchWallets(this.db, 'watching').length;
    const freeChair = repo.activeActivationCount(this.db) < this.risk.ROSTER_SIZE;
    for (const wallet of repo.listWatchWallets(this.db, 'cooling')) {
      const firedAt = repo.lastFiredAt(this.db, wallet.candidateId);
      if (firedAt === null) continue; // fail closed: no firing clock, no re-entry
      const anotherHired = repo.hasHireSince(this.db, firedAt, wallet.candidateId);
      if (
        !canReenter({
          lastFiredAt: firedAt,
          nowMs: Date.now(),
          cooldownHours: this.risk.COOLDOWN_HOURS,
          anotherHiredSinceFire: anotherHired,
          freeChair,
        })
      ) {
        continue;
      }
      // The watch list is a funnel cap, not a re-entry right: wait for room.
      if (watchingCount >= this.risk.WATCH_LIST_SIZE) continue;
      const reason = anotherHired
        ? 're-entry: another trader was hired after the firing'
        : `re-entry: ${this.risk.COOLDOWN_HOURS}h elapsed with a free chair`;
      repo.setWatchStatus(this.db, wallet.candidateId, 'watching', reason);
      repo.audit(this.db, 'watch', `watch re-admitted: ${reason}`, {
        candidateId: wallet.candidateId,
        lastFiredAt: firedAt,
      });
      watchingCount++;
      readmitted++;
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
