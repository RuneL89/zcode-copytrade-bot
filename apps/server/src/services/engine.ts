import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import type { PriceProvider } from '@zcode-bot/providers';
import {
  applyCloseUnit,
  bankrollHeadroom,
  capitalPctCapUsdMicro,
  classifyLeaderEvent,
  countsAsUnit,
  evaluateEntryRisk,
  exitSlippageBps,
  guardExitMode,
  isEventTooOld,
  leaderSoldFraction,
  planCopiedExit,
  sizeCopy,
  stringifyBigIntSafe,
  usdToMicro,
  type LeaderClassifiedEvent,
  type LeaderTxSummary,
} from '@zcode-bot/core';
import type {
  Executor,
  ExecOutcome,
  ExecutionHooks,
  IntentSpec,
  QuoteCheck,
  SignedTransactionInfo,
} from './executors.js';
import { MIN_SOL_FOR_FEES_LAMPORTS, SOL_LOW_WATERMARK_LAMPORTS } from './executors.js';
import type { ControlService } from './control.js';
import { createTradingLocks, type TradingLocks } from './locks.js';
import type { Notifier } from '@zcode-bot/providers';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Same-mint buys inside this window are one burst, not a second position (D4). */
export const COALESCE_SAME_MINT_MS = 60_000;
/** Budget held for a pending entry on top of its notional (fees/tip/rent). */
export const ENTRY_FEE_RESERVE_USD_MICRO = 10_000n;
/** Close-out attempts per position during a fire (pre-submission failures only). */
const CLOSE_ATTEMPTS = 3;
const CLOSE_BACKOFF_MS = 800;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bounded retries for an exit that failed before a signature existed. */
export const EXIT_QUEUE_MAX_ATTEMPTS = 4;
/** How often the runtime drains the exit queue. */
export const EXIT_QUEUE_RETRY_MS = 30_000;
const EXIT_QUEUE_BACKOFF_MS = 30_000;

interface ExitQueueContext {
  intentId: string;
  exitBase: bigint;
  remainingBefore: bigint;
  remainingAfter: bigint;
  full: boolean;
  closeReason: string;
  leaderSignature: string | null;
}

interface ExitQueueEntry {
  at?: string;
  attempt?: number;
  detail?: string;
  intentId?: string;
  exitBase?: string;
  remainingBefore?: string;
  remainingAfter?: string;
  full?: boolean;
  closeReason?: string;
  leaderSignature?: string | null;
}

/**
 * Base units a position holds after selling `exitBase`. Always scoped to the
 * position, never to the wallet: every seat shares one wallet, so the wallet's
 * balance of a mint also counts tokens another chair's position owns. A full
 * close ends at zero even when delivery slippage left the recorded amount above
 * what the chain ever held.
 */
export function remainingAfterForSale(recordedBase: bigint, exitBase: bigint, full: boolean): bigint {
  if (full) return 0n;
  return recordedBase > exitBase ? recordedBase - exitBase : 0n;
}

/** One confirmed transaction's effects on the trading wallet. */
export interface ChainTransactionDetail {
  err: unknown;
  slot: number | null;
  blockTime: number | null;
  /** SPL token balance deltas by mint (post - pre). */
  tokenDeltas: Record<string, { pre: bigint; post: bigint }>;
  /** Native SOL balance delta for the wallet (post - pre). */
  solLamportsDelta: bigint;
  feeLamports: number;
  tipLamports: number;
}

/** Read-only chain evidence used by reconciliation (implemented by Helius). */
export interface ReconciliationReader {
  signatureStatus(signature: string): Promise<{
    found: boolean;
    err: unknown;
    confirmationStatus?: string;
  } | null>;
  blockHeight(): Promise<number | null>;
  transactionDetail(signature: string, owner: string): Promise<ChainTransactionDetail | null>;
}

export interface EngineCallbacks {
  /** Called when a close unit pushes the streak to the fire threshold. */
  onFired: (activationId: string, candidateId: string, reason: string) => void;
  /** Called after every state-changing engine action (rebuild dashboard state). */
  onStateChanged: () => void;
  /** A queued fire_close filled; let the lifecycle finish the blocked fire. */
  onFireCloseFilled?: (activationId: string) => void | Promise<void>;
}

export class CopyEngine {
  constructor(
    private db: AppDatabase,
    private risk: RiskConfig,
    private prices: PriceProvider,
    private executor: Executor,
    private control: ControlService,
    private notifier: Notifier,
    private callbacks: EngineCallbacks,
    private walletPublicKey: string | null,
    private equityStartUsdMicro: bigint = 1_000_000_000n,
    private liveMode: boolean = false,
    private locks: TradingLocks = createTradingLocks(),
  ) {}

  /** The book this engine trades. Paper rows are invisible to live and vice versa. */
  get mode(): 'paper' | 'live' {
    return this.liveMode ? 'live' : 'paper';
  }

  setRisk(risk: RiskConfig): void {
    this.risk = risk;
  }

  /** Shared with the lifecycle so firing and entries cannot interleave. */
  withActivationLock<T>(activationId: string, fn: () => Promise<T> | T): Promise<T> {
    return this.locks.activation(activationId, fn);
  }

  /**
   * Current-mode exposure: remaining cost basis + remaining entry fees of
   * open/partial/reconciling positions, plus entry reservations and unresolved
   * entries. Partial closes release basis; reconciling lots still consume it.
   */
  /**
   * Stored remaining basis, with a proportional fallback for legacy rows whose
   * added column is still the default zero. New rows and the migration fill it.
   */
  private remainingBasis(p: {
    inputUsdMicro: string;
    copiedTokenBase: string;
    remainingTokenBase: string;
    remainingCostBasisUsdMicro: string;
  }): bigint {
    const stored = BigInt(p.remainingCostBasisUsdMicro);
    if (stored > 0n || BigInt(p.inputUsdMicro) === 0n) return stored;
    const copied = BigInt(p.copiedTokenBase);
    return copied > 0n ? (BigInt(p.inputUsdMicro) * BigInt(p.remainingTokenBase)) / copied : 0n;
  }

  private remainingFees(p: {
    feesUsdMicro: string;
    copiedTokenBase: string;
    remainingTokenBase: string;
    remainingFeesUsdMicro: string;
  }): bigint {
    const stored = BigInt(p.remainingFeesUsdMicro);
    if (stored > 0n || BigInt(p.feesUsdMicro) === 0n) return stored;
    const copied = BigInt(p.copiedTokenBase);
    return copied > 0n ? (BigInt(p.feesUsdMicro) * BigInt(p.remainingTokenBase)) / copied : 0n;
  }

  private exposure() {
    const positions = repo.exposurePositions(this.db, this.mode);
    const pending = repo.pendingEntryIntents(this.db, this.mode);
    const unresolved = repo.unresolvedEntryIntents(this.db, this.mode);
    const withdrawals = repo.withdrawalTotals(this.db, this.mode);
    const openEntriesUsdMicro = positions.reduce((acc, p) => acc + this.remainingBasis(p), 0n);
    const openFeesUsdMicro = positions.reduce((acc, p) => acc + this.remainingFees(p), 0n);
    const reservedEntryUsdMicro =
      pending.reduce((acc, i) => acc + BigInt(i.reservedUsdMicro), 0n) +
      unresolved.reduce((acc, i) => acc + BigInt(i.inputUsdMicro ?? '0'), 0n);
    return {
      positions,
      pending,
      unresolved,
      openEntriesUsdMicro,
      openFeesUsdMicro,
      reservedEntryUsdMicro,
      capitalAdjustmentsUsdMicro: -(withdrawals.sentUsdMicro + withdrawals.reservedUsdMicro),
    };
  }

  /**
   * Leaderboard staleness applies to board-sourced hires. A watch-list hire is
   * judged by its on-chain funded-buy record, not by a board row it may not
   * have; passing null makes the rule inapplicable instead of fake-fresh.
   */
  private leaderboardAgeSeconds(candidateId: string): number | null {
    const candidate = repo.getCandidate(this.db, candidateId);
    if (!candidate?.observedAt) return null;
    if (repo.getWatchWallet(this.db, candidateId)) return null;
    const ms = Date.parse(candidate.observedAt);
    return Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 1000)) : null;
  }

  private bank() {
    const exposure = this.exposure();
    return {
      exposure,
      bank: bankrollHeadroom({
        equityStartUsdMicro: this.equityStartUsdMicro,
        openEntriesUsdMicro: exposure.openEntriesUsdMicro,
        openFeesUsdMicro: exposure.openFeesUsdMicro,
        reservedEntryUsdMicro: exposure.reservedEntryUsdMicro,
        capitalAdjustmentsUsdMicro: exposure.capitalAdjustmentsUsdMicro,
        realizedNetUsdMicro: repo.realizedPnlSince(this.db, '1970-01-01T00:00:00.000Z', this.mode),
        maxDeployedPct: this.risk.MAX_DEPLOYED_PCT,
      }),
    };
  }

  /**
   * Remaining room under MAX_DEPLOYED_PCT, micro-USD — the same math the entry
   * path uses. The D4 promotion gate reads it before it will hand a wallet to
   * the roster.
   */
  headroomUsdMicro(): bigint {
    return this.bank().bank.headroomUsdMicro;
  }

  // ---------------------------------------------------------------------
  // Leader events
  // ---------------------------------------------------------------------

  async handleLeaderTx(activationId: string, candidateId: string, summary: LeaderTxSummary): Promise<void> {
    // Only an ACTIVE trader's events are processed; FIRING/FIRED/RECONCILING
    // activations accept no new entries (exits for pending closes are handled
    // by the lifecycle's own close paths).
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state !== 'ACTIVE' || activation.mode !== this.mode) return;

    const event = classifyLeaderEvent(summary);
    const dedupeKey = `${summary.chain}:${summary.leaderAddress}:${summary.signature}:0`;
    const inserted = repo.insertObservedEvent(this.db, {
      dedupeKey,
      activationId,
      candidateId,
      address: summary.leaderAddress,
      signature: summary.signature,
      slot: summary.slot,
      transactionIndex: summary.transactionIndex,
      blockTime: summary.blockTime,
      kind: event.kind,
      skipReason: event.kind === 'skipped' ? event.reason : null,
      detailJson: stringifyBigIntSafe(event),
      rawRef: summary.signature,
      parserVersion: event.parserVersion,
      processedAt: new Date().toISOString(),
    });
    if (!inserted) return; // duplicate (signature+leg) — already processed

    if (event.kind === 'skipped') return;
    if (event.kind === 'swap_buy') await this.handleLeaderBuy(activationId, candidateId, summary, event);
    if (event.kind === 'swap_sell') await this.handleLeaderSell(activationId, candidateId, summary, event);
    if (event.kind === 'swap_rotate')
      await this.handleLeaderRotate(activationId, candidateId, summary, event);
    this.callbacks.onStateChanged();
  }

  private async handleLeaderBuy(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_buy' }>,
  ): Promise<void> {
    // Serialize entries with fire and with other entries for this seat. Fire
    // takes the same lock before enumerating positions, so a fill cannot land
    // after close-out and become an orphan.
    await this.locks.activation(activationId, () =>
      this.handleLeaderBuyLocked(activationId, candidateId, summary, event),
    );
  }

  private async handleLeaderBuyLocked(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_buy' }>,
  ): Promise<void> {
    void summary;
    // Re-check inside the lock: firing may have completed while this buy waited.
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state !== 'ACTIVE' || activation.mode !== this.mode) return;
    // An unknown outcome on this seat means its exposure is not trustworthy.
    // Freeze new entries until reconciliation resolves the case.
    if (repo.openReconciliationCaseForActivation(this.db, activationId)) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'RECONCILIATION_OPEN',
        limitValue: '0',
        actualValue: '1',
        detail: 'new entries frozen while this seat has an open reconciliation case',
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Old events are never entered late.
    if (isEventTooOld(event.blockTime, Date.now(), this.risk.MAX_COPY_EVENT_AGE_SECONDS)) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'MAX_COPY_EVENT_AGE_SECONDS',
        limitValue: String(this.risk.MAX_COPY_EVENT_AGE_SECONDS),
        actualValue: String(Math.round((Date.now() - event.blockTime * 1000) / 1000)),
        detail: `stale buy ${event.signature}`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // D4/plan 05 — same-mint burst coalescing: a burst of buys for a mint we
    // already hold from THIS leader inside the window adds nothing (one
    // position per mint per leader; the first copy is the position).
    const heldForMint = repo.openPositionForMint(this.db, candidateId, event.mint);
    if (heldForMint && Date.now() - Date.parse(heldForMint.openedAt) < COALESCE_SAME_MINT_MS) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'COALESCED_SAME_MINT_BURST',
        limitValue: String(COALESCE_SAME_MINT_MS),
        actualValue: String(Date.now() - Date.parse(heldForMint.openedAt)),
        detail: `same-mint burst on ${event.mint}: position ${heldForMint.positionId} is ${Math.round((Date.now() - Date.parse(heldForMint.openedAt)) / 1000)}s old`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Measure leader input notional from the funding leg with fresh pricing.
    let leaderInputUsdMicro: bigint;
    let inputMint: string;
    let inputDecimals: number;
    let inputAmountBase: bigint;
    let priceObservedAt: number | null = null;
    if (event.fundingMint === USDC_MINT || event.fundingMint === USDT_MINT) {
      inputMint = event.fundingMint;
      inputDecimals = event.fundingDecimals;
      inputAmountBase = event.fundingDeltaBase;
      leaderInputUsdMicro = event.fundingDeltaBase; // 6-dec stables: base == micro-USD
    } else {
      // SOL funding: price the SOL leg.
      inputMint = SOL_MINT;
      inputDecimals = 9;
      inputAmountBase = event.fundingDeltaBase;
      const price = await this.prices.priceOf(SOL_MINT, 9);
      priceObservedAt = price.observedAt;
      leaderInputUsdMicro = (inputAmountBase * price.priceUsdMicro) / 10n ** 9n;
    }

    const intentId = 'intent_' + randomUUID();
    const idempotencyKey = `entry:${activationId}:${event.signature}:${event.mint}`;

    // Atomic reserve: recompute exposure, size, apply the per-mint cap and
    // insert the intent while holding the budget lock. Concurrent leader buys
    // then see this reservation instead of both passing the same headroom.
    let sizing!: ReturnType<typeof sizeCopy>;
    let bank!: ReturnType<typeof bankrollHeadroom>;
    let maxPerBuyUsdMicro = 0n;
    let skipReason: string | null = null;
    await this.locks.budget(async () => {
      const book = this.bank();
      bank = book.bank;
      const exposure = book.exposure;
      const traderOpen =
        exposure.positions
          .filter((p) => p.candidateId === candidateId)
          .reduce((acc, p) => acc + this.remainingBasis(p) + this.remainingFees(p), 0n) +
        exposure.pending
          .filter((i) => i.candidateId === candidateId)
          .reduce((acc, i) => acc + BigInt(i.reservedUsdMicro), 0n) +
        exposure.unresolved
          .filter((i) => i.candidateId === candidateId)
          .reduce((acc, i) => acc + BigInt(i.inputUsdMicro ?? '0'), 0n);
      // Exposure caps are percentages of CURRENT capital, so the profile holds
      // as the bankroll grows. The $2 floor still wins when capital is tiny.
      const minPerBuy = usdToMicro(this.risk.MIN_PER_BUY_USD);
      const maxPerBuy = capitalPctCapUsdMicro(bank.capitalUsdMicro, this.risk.MAX_PER_BUY_PCT, minPerBuy);
      const maxOpenPerTrader = capitalPctCapUsdMicro(
        bank.capitalUsdMicro,
        this.risk.MAX_OPEN_PER_TRADER_PCT,
        maxPerBuy,
      );
      maxPerBuyUsdMicro = maxPerBuy;
      sizing = sizeCopy({
        leaderInputUsdMicro,
        scaleNumerator: BigInt(Math.round(this.risk.COPY_SCALE * 10000)),
        scaleDenominator: 10000n,
        minPerBuyUsdMicro: minPerBuy,
        maxPerBuyUsdMicro: maxPerBuy,
        traderOpenUsdMicro: traderOpen,
        maxOpenPerTraderUsdMicro: maxOpenPerTrader,
        bankrollHeadroomUsdMicro: bank.headroomUsdMicro,
      });
      // A pending entry for the same mint is this burst's copy; the position
      // does not exist yet, so the position-based coalescing check cannot see
      // it. Skip the second intent instead of reserving budget twice.
      const pendingSameMint = exposure.pending.find(
        (i) =>
          i.candidateId === candidateId &&
          i.mint === event.mint &&
          Date.now() - Date.parse(i.createdAt) < COALESCE_SAME_MINT_MS,
      );
      if (pendingSameMint) {
        skipReason = 'COALESCED_SAME_MINT_BURST: a pending entry for this mint is in flight';
      }
      if (skipReason === null && sizing.action === 'copy' && this.risk.PER_MINT_CAP_USD > 0) {
        const capMicro = usdToMicro(this.risk.PER_MINT_CAP_USD);
        const openForMint =
          exposure.positions
            .filter((p) => p.mint === event.mint)
            .reduce((acc, p) => acc + this.remainingBasis(p) + this.remainingFees(p), 0n) +
          exposure.pending
            .filter((i) => i.mint === event.mint)
            .reduce((acc, i) => acc + BigInt(i.reservedUsdMicro), 0n) +
          exposure.unresolved
            .filter((i) => i.mint === event.mint)
            .reduce((acc, i) => acc + BigInt(i.inputUsdMicro ?? '0'), 0n);
        if (openForMint + sizing.finalUsdMicro > capMicro) {
          repo.insertRiskRejection(this.db, {
            activationId,
            rule: 'PER_MINT_CAP',
            limitValue: capMicro.toString(),
            actualValue: (openForMint + sizing.finalUsdMicro).toString(),
            detail: `per-mint cap would be exceeded for ${event.mint} across the roster`,
            createdAt: new Date().toISOString(),
          });
          skipReason = 'PER_MINT_CAP: would exceed the roster mint cap';
        }
      }
      const nowIso = new Date().toISOString();
      if (sizing.action === 'copy' && skipReason === null) {
        repo.insertIntent(this.db, {
          intentId,
          kind: 'entry',
          mode: this.mode,
          activationId,
          candidateId,
          positionId: null,
          mint: event.mint,
          inputMint,
          inputAmountBase: '0',
          inputUsdMicro: sizing.finalUsdMicro.toString(),
          inputDecimals,
          outputDecimals: event.mintDecimals,
          state: 'pending_quote',
          idempotencyKey,
          reservedUsdMicro: (sizing.finalUsdMicro + ENTRY_FEE_RESERVE_USD_MICRO).toString(),
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      } else {
        repo.insertIntent(this.db, {
          intentId,
          kind: 'entry',
          mode: this.mode,
          activationId,
          candidateId,
          positionId: null,
          mint: event.mint,
          inputMint,
          inputAmountBase: '0',
          inputUsdMicro: '0',
          state: 'skipped',
          idempotencyKey,
          reason:
            skipReason ??
            (sizing.action === 'skip_invalid'
              ? 'invalid input'
              : sizing.action === 'skip_headroom'
                ? sizing.rule === 'MAX_DEPLOYED_PCT'
                  ? 'MAX_DEPLOYED_PCT: bankroll cap'
                  : `${sizing.rule}: headroom`
                : 'skipped'),
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    });

    if (sizing.action !== 'copy' || skipReason !== null) {
      if (sizing.action === 'skip_headroom') {
        repo.insertRiskRejection(this.db, {
          activationId,
          rule: sizing.rule,
          limitValue: sizing.headroomUsdMicro.toString(),
          actualValue: leaderInputUsdMicro.toString(),
          detail:
            sizing.rule === 'MAX_DEPLOYED_PCT'
              ? `bankroll cap: ${(Number(bank.deployedUsdMicro) / 1e6).toFixed(2)} of ${(
                  Number(bank.capitalUsdMicro) / 1e6
                ).toFixed(2)} deployed, headroom ${(Number(bank.headroomUsdMicro) / 1e6).toFixed(2)}`
              : `trader open cap, headroom ${(Number(sizing.headroomUsdMicro) / 1e6).toFixed(2)}`,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }
    const notional = sizing.finalUsdMicro;

    // Convert notional to input token base units.
    let amountBase: bigint;
    if (inputMint === USDC_MINT || inputMint === USDT_MINT) {
      amountBase = notional; // micro-USD == base units of 6-dec stables
    } else {
      const price = await this.prices.priceOf(inputMint, inputDecimals);
      priceObservedAt = price.observedAt;
      amountBase = (notional * 10n ** BigInt(inputDecimals)) / price.priceUsdMicro;
      if (amountBase <= 0n) {
        repo.transitionIntent(this.db, intentId, 'skipped', {
          reason: 'sized amount rounded to zero at current price',
        });
        repo.insertRiskRejection(this.db, {
          activationId,
          rule: 'PRICE_MAX_AGE_SECONDS',
          limitValue: String(this.risk.PRICE_MAX_AGE_SECONDS),
          actualValue: '0',
          detail: 'sized amount rounded to zero at current price',
          createdAt: new Date().toISOString(),
        });
        return;
      }
    }
    repo.updateIntent(this.db, intentId, { inputAmountBase: amountBase.toString() });
    const priceAgeSeconds =
      priceObservedAt === null ? 0 : Math.max(0, Math.round((Date.now() - priceObservedAt) / 1000));

    const decision = evaluateEntryRisk(this.risk, {
      entryUsdMicro: notional,
      maxEntryUsdMicro: maxPerBuyUsdMicro,
      eventAgeSeconds: Math.max(0, Math.round((Date.now() - event.blockTime * 1000) / 1000)),
      priceAgeSeconds: priceAgeSeconds,
      leaderboardAgeSeconds: this.leaderboardAgeSeconds(candidateId),
      quoteSlippageBps: null,
      quotePriceImpactBps: null,
    });
    if (!decision.allowed) {
      repo.transitionIntent(this.db, intentId, 'skipped', {
        inputAmountBase: amountBase.toString(),
        inputUsdMicro: notional.toString(),
        reason: `${decision.rule}: ${decision.detail}`,
      });
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: decision.rule,
        limitValue: decision.limit,
        actualValue: decision.value,
        detail: decision.detail,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Entry gates: pause/emergency, and in live mode the explicit ARM.
    // Pre-arm (or post-restart) live never trades — not even simulated. The
    // executor check is belt-and-braces: an armed flag without a mounted live
    // executor would otherwise fall through to the paper simulator.
    if (this.liveMode && (!this.control.flags.armed || this.executor.mode !== 'live')) {
      repo.transitionIntent(this.db, intentId, 'skipped', {
        inputAmountBase: '0',
        inputUsdMicro: sizing.finalUsdMicro!.toString(),
        reason: this.control.flags.armed ? 'wallet locked: live executor not mounted' : 'live mode not armed',
      });
      return;
    }

    // Entry gates: pause/emergency.
    if (!this.control.entriesAllowed()) {
      repo.transitionIntent(this.db, intentId, 'skipped', {
        inputAmountBase: amountBase.toString(),
        inputUsdMicro: notional.toString(),
        reason: this.control.flags.emergencyStopped
          ? 'EMERGENCY STOP'
          : this.control.withdrawInFlight
            ? 'withdrawal in progress'
            : 'new entries paused',
      });
      return;
    }

    const spec: IntentSpec = {
      intentId,
      activationId,
      kind: 'entry',
      inputMint,
      outputMint: event.mint,
      inputAmountBase: amountBase.toString(),
      inputDecimals: inputDecimals,
      outputDecimals: event.mintDecimals,
      inputUsdMicro: notional.toString(),
      slippageBpsCap: this.risk.MAX_SLIPPAGE_BPS,
      userPublicKey: this.walletPublicKey,
    };

    // Persisted (pending_quote + reservation) before any quote/sign.
    await this.runIntent(spec, { activationId, candidateId, eventSignature: event.signature });
  }

  /**
   * Coin-for-coin rotation (operator decision 2026-11-22): the leader exited
   * one coin and entered another in the same transaction. Mirror both legs
   * through the existing handlers — exit our position in the outgoing coin
   * via the normal leader-sell path (proportional, no-op when we hold none),
   * then enter the incoming coin via the normal leader-buy path, sized at
   * 0.25x of the incoming coin's swap-time USD value inside every existing
   * cap. One quote prices both legs: the rotation's own exchange rate makes
   * the outgoing coin worth what the incoming coin was received for. Fail
   * closed: a stale or unpriceable rotation trades neither leg and records
   * why.
   */
  private async handleLeaderRotate(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_rotate' }>,
  ): Promise<void> {
    if (isEventTooOld(event.blockTime, Date.now(), this.risk.MAX_COPY_EVENT_AGE_SECONDS)) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'MAX_COPY_EVENT_AGE_SECONDS',
        limitValue: String(this.risk.MAX_COPY_EVENT_AGE_SECONDS),
        actualValue: String(Math.round((Date.now() - event.blockTime * 1000) / 1000)),
        detail: `stale rotation ${event.signature}`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    let leaderInUsdMicro: bigint;
    try {
      const price = await this.prices.priceOf(event.mint, event.mintDecimals);
      leaderInUsdMicro =
        (event.tokenDeltaBase * price.priceUsdMicro) / 10n ** BigInt(Math.max(0, event.mintDecimals));
    } catch {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'ROTATION_UNPRICED',
        limitValue: '0',
        actualValue: '1',
        detail: `no quote for the incoming coin ${event.mint}: rotation ${event.signature} not mirrored`,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    if (leaderInUsdMicro <= 0n) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'ROTATION_UNPRICED',
        limitValue: '0',
        actualValue: String(leaderInUsdMicro),
        detail: `non-positive value for the incoming coin ${event.mint}: rotation ${event.signature} not mirrored`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Exit leg first: releases the outgoing basis before the entry reserves
    // new exposure. Position lock only, released before the entry's
    // activation+budget locks — no inversion. No held position no-ops.
    await this.handleLeaderSell(activationId, candidateId, summary, {
      kind: 'swap_sell',
      signature: event.signature,
      slot: event.slot,
      transactionIndex: event.transactionIndex,
      blockTime: event.blockTime,
      legIndex: 0,
      mint: event.outMint,
      mintDecimals: event.outMintDecimals,
      tokenDeltaBase: event.outTokenDeltaBase,
      fundingMint: event.mint,
      fundingDecimals: event.mintDecimals,
      fundingDeltaBase: 0n,
      parserVersion: event.parserVersion,
    });

    // Entry leg through the normal buy path: the USDC funding branch takes
    // the micro-USD value verbatim, so sizing, budget reservation, coalescing
    // and every gate behave exactly as for a funded buy.
    await this.handleLeaderBuy(activationId, candidateId, summary, {
      kind: 'swap_buy',
      signature: event.signature,
      slot: event.slot,
      transactionIndex: event.transactionIndex,
      blockTime: event.blockTime,
      legIndex: 0,
      mint: event.mint,
      mintDecimals: event.mintDecimals,
      tokenDeltaBase: event.tokenDeltaBase,
      fundingMint: USDC_MINT,
      fundingDecimals: 6,
      fundingDeltaBase: leaderInUsdMicro,
      parserVersion: event.parserVersion,
    });
  }

  private async handleLeaderSell(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_sell' }>,
  ): Promise<void> {
    // Mirrored exits continue even when new entries are paused.
    const position = repo.openPositionForMint(this.db, candidateId, event.mint, this.mode);
    if (!position) return;

    const delta = summary.tokenDeltas.find((d) => d.mint === event.mint);
    if (!delta || delta.preBase <= 0n) return;
    const fraction = leaderSoldFraction({ preBase: delta.preBase, postBase: delta.postBase });
    const plan = planCopiedExit({
      remainingBase: BigInt(position.remainingTokenBase),
      soldBps: fraction.soldBps,
      full: fraction.full,
    });
    if (plan.exitBase <= 0n) return;

    await this.executeExit(
      position.positionId,
      plan.exitBase,
      plan.remainingBase,
      plan.full,
      'leader_exit',
      event.signature,
    );
    this.callbacks.onStateChanged();
  }

  /** Sell a fraction of the remaining position (partial take-profit). 10000 closes it. */
  async closeShare(
    positionId: string,
    sellBps: number,
    reason: string,
  ): Promise<'closed' | 'partial' | 'unknown' | 'failed'> {
    const position = repo.getPosition(this.db, positionId);
    if (!position) return 'failed';
    const remaining = BigInt(position.remainingTokenBase);
    if (remaining <= 0n) return 'closed';
    const exitBase = (remaining * BigInt(Math.min(10_000, Math.max(0, Math.floor(sellBps))))) / 10_000n;
    if (exitBase <= 0n || exitBase >= remaining) {
      const full = await this.closePosition(positionId, reason);
      return full === 'closed' ? 'closed' : full;
    }
    const out = await this.executeExit(positionId, exitBase, remaining - exitBase, false, reason, null);
    this.callbacks.onStateChanged();
    if (out === 'no-position') return 'failed';
    if (out.kind === 'filled') return 'partial';
    if (out.kind === 'unknown') return 'unknown';
    return 'failed';
  }

  private exitAttempt(positionId: string): number {
    const raw = repo.kvGet(this.db, `exit.attempt:${positionId}`);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /** Pre-signature failure: keep retrying, and do not freeze the chair. */
  private queueExit(positionId: string, detail: string, context?: ExitQueueContext): void {
    const next = this.exitAttempt(positionId) + 1;
    repo.kvSet(this.db, `exit.attempt:${positionId}`, String(next));
    const entry = {
      at: new Date().toISOString(),
      attempt: next,
      detail,
      ...(context
        ? {
            intentId: context.intentId,
            exitBase: context.exitBase.toString(),
            remainingBefore: context.remainingBefore.toString(),
            remainingAfter: context.remainingAfter.toString(),
            full: context.full,
            closeReason: context.closeReason,
            leaderSignature: context.leaderSignature,
          }
        : {}),
    };
    repo.kvSet(this.db, `exit.queue:${positionId}`, JSON.stringify(entry));
  }

  /** Clear the queue entry. Exhaustion keeps the attempt index for the slippage ladder. */
  private clearExitQueue(positionId: string, clearAttempt = true): void {
    repo.kvDelete(this.db, `exit.queue:${positionId}`);
    if (clearAttempt) repo.kvDelete(this.db, `exit.attempt:${positionId}`);
  }

  /**
   * Close the entire remaining position (fire policy / close-all / emergency).
   * A frozen (requires_reconciliation) position is refused unless the caller
   * has already proved the exit is safe (`allowFrozen`): the signature-less
   * reconciliation retry and the late-fill flattener pass it; an agent/manual
   * close does not.
   */
  async closePosition(
    positionId: string,
    reason: string,
    opts: { allowFrozen?: boolean } = {},
  ): Promise<'closed' | 'unknown' | 'failed'> {
    const position = repo.getPosition(this.db, positionId);
    if (!position) return 'failed';
    const remaining = BigInt(position.remainingTokenBase);
    if (remaining <= 0n) return 'closed';
    const out = await this.executeExit(positionId, remaining, 0n, true, reason, null, opts);
    this.callbacks.onStateChanged();
    if (out === 'no-position') return 'failed';
    if (out.kind === 'filled') return 'closed';
    if (out.kind === 'unknown') return 'unknown';
    return 'failed';
  }

  async closeAllForActivation(activationId: string): Promise<{
    closed: number;
    unknown: number;
    failed: number;
  }> {
    const positions = repo.openPositions(this.db, this.mode).filter((p) => p.activationId === activationId);
    let closed = 0;
    let unknown = 0;
    let failed = 0;
    for (let i = 0; i < positions.length; i++) {
      // Space the closes: two quotes back to back is what tripped Jupiter's 429.
      if (i > 0) await sleep(400 + Math.random() * 400);
      const position = positions[i]!;
      let result: 'closed' | 'unknown' | 'failed' = 'failed';
      for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
        result = await this.closePosition(position.positionId, 'fire_close_all');
        if (result !== 'failed') break;
        if (attempt < CLOSE_ATTEMPTS) {
          const backoff = CLOSE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 400;
          repo.audit(
            this.db,
            'firing',
            `close retry ${attempt + 1}/${CLOSE_ATTEMPTS} in ${Math.round(backoff)}ms`,
            {
              positionId: position.positionId,
              mint: position.mint,
            },
          );
          await sleep(backoff);
        }
      }
      if (result === 'closed') closed++;
      else if (result === 'unknown') unknown++;
      else failed++;
    }
    return { closed, unknown, failed };
  }

  /**
   * Drain pre-signature exit failures. The queue is written whenever an exit
   * fails before a signature exists; this consumer retries those intents with
   * backoff, never a signed/submitted/unknown one. It re-checks the position
   * and remaining base before selling, so a retry cannot double-sell. The
   * existing code exits remain the backstop and the chair is never frozen.
   */
  async retryQueuedExits(nowMs = Date.now()): Promise<{
    scanned: number;
    retried: number;
    filled: number;
    failed: number;
    exhausted: number;
    skipped: number;
  }> {
    const out = { scanned: 0, retried: 0, filled: 0, failed: 0, exhausted: 0, skipped: 0 };
    const prefix = 'exit.queue:';

    for (const row of repo.listKvByPrefix(this.db, prefix)) {
      out.scanned++;
      const positionId = row.key.slice(prefix.length);
      let entry: ExitQueueEntry;
      try {
        entry = JSON.parse(row.value) as ExitQueueEntry;
      } catch {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', 'exit queue malformed; entry discarded', { positionId });
        out.skipped++;
        continue;
      }

      const position = repo.getPosition(this.db, positionId);
      if (!position) {
        this.clearExitQueue(positionId);
        out.skipped++;
        continue;
      }
      if (position.status !== 'open' && position.status !== 'partially_closed') {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', `exit queue skipped: position is ${position.status}`, {
          positionId,
          mint: position.mint,
        });
        out.skipped++;
        continue;
      }

      // Only an intent that provably never reached submission is retryable.
      const intent = entry.intentId
        ? repo.getIntent(this.db, entry.intentId)
        : repo.latestFailedExitIntent(this.db, positionId);
      if (
        !intent ||
        intent.positionId !== positionId ||
        intent.state !== 'failed' ||
        intent.txSignature !== null
      ) {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', 'exit queue skipped: intent was signed or is no longer failed', {
          positionId,
          intentId: entry.intentId ?? intent?.intentId ?? null,
          state: intent?.state ?? null,
          hasSignature: intent?.txSignature != null,
        });
        out.skipped++;
        continue;
      }

      let currentRemaining: bigint;
      try {
        currentRemaining = BigInt(position.remainingTokenBase);
      } catch {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', 'exit queue skipped: unreadable remaining base', { positionId });
        out.skipped++;
        continue;
      }
      if (currentRemaining <= 0n) {
        this.clearExitQueue(positionId);
        out.skipped++;
        continue;
      }

      let exitBase: bigint;
      let remainingBefore: bigint;
      let full: boolean;
      let closeReason: string;
      let leaderSignature: string | null;
      if (
        entry.exitBase !== undefined &&
        entry.remainingBefore !== undefined &&
        typeof entry.full === 'boolean'
      ) {
        try {
          exitBase = BigInt(entry.exitBase);
          remainingBefore = BigInt(entry.remainingBefore);
        } catch {
          this.clearExitQueue(positionId);
          repo.audit(this.db, 'trade', 'exit queue malformed; entry discarded', { positionId });
          out.skipped++;
          continue;
        }
        if (remainingBefore !== currentRemaining) {
          this.clearExitQueue(positionId);
          repo.audit(this.db, 'trade', 'exit queue skipped: position remaining base changed', {
            positionId,
            expectedBase: remainingBefore.toString(),
            currentBase: currentRemaining.toString(),
          });
          out.skipped++;
          continue;
        }
        full = entry.full;
        if (full) exitBase = currentRemaining;
        closeReason = entry.closeReason ?? 'exit_queue_retry';
        leaderSignature = entry.leaderSignature ?? null;
      } else {
        // Legacy queue rows have no plan metadata. Retry only when the failed
        // intent targeted the whole remaining position, which is provable from
        // the intent's input amount; otherwise leave it to the code exits.
        try {
          exitBase = BigInt(intent.inputAmountBase);
        } catch {
          exitBase = 0n;
        }
        if (exitBase <= 0n || exitBase !== currentRemaining) {
          this.clearExitQueue(positionId);
          repo.audit(this.db, 'trade', 'exit queue legacy entry skipped: cannot prove unchanged size', {
            positionId,
            intentBase: exitBase.toString(),
            currentBase: currentRemaining.toString(),
          });
          out.skipped++;
          continue;
        }
        remainingBefore = currentRemaining;
        full = true;
        closeReason = intent.kind === 'fire_close' ? 'fire_close_all' : 'exit_queue_retry';
        leaderSignature = null;
      }
      if (exitBase <= 0n || exitBase > currentRemaining) {
        this.clearExitQueue(positionId);
        out.skipped++;
        continue;
      }

      const attempt = Math.max(1, Math.floor(entry.attempt ?? this.exitAttempt(positionId)));
      if (!Number.isFinite(attempt)) {
        this.clearExitQueue(positionId);
        out.skipped++;
        continue;
      }
      if (attempt >= EXIT_QUEUE_MAX_ATTEMPTS) {
        // Keep exit.attempt: the next code exit keeps the widest slippage step.
        repo.kvDelete(this.db, `${prefix}${positionId}`);
        repo.audit(
          this.db,
          'trade',
          `exit queue exhausted after ${attempt} attempts; code exits remain the backstop`,
          { positionId, mint: position.mint, attempt, detail: entry.detail ?? null },
        );
        out.exhausted++;
        continue;
      }

      const queuedAt = entry.at ? Date.parse(entry.at) : NaN;
      if (!Number.isFinite(queuedAt)) {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', 'exit queue malformed; entry discarded', { positionId });
        out.skipped++;
        continue;
      }
      const waitMs = EXIT_QUEUE_BACKOFF_MS * 2 ** (attempt - 1);
      if (nowMs - queuedAt < waitMs) continue;

      out.retried++;
      const remainingAfter = full ? 0n : remainingAfterForSale(currentRemaining, exitBase, false);
      let result: ExecOutcome | 'no-position';
      try {
        result = await this.executeExit(
          positionId,
          exitBase,
          remainingAfter,
          full,
          closeReason,
          leaderSignature,
        );
      } catch (e) {
        const detail = `exit queue retry error: ${(e as Error).message}`;
        this.queueExit(positionId, detail, {
          intentId: intent.intentId,
          exitBase,
          remainingBefore,
          remainingAfter,
          full,
          closeReason,
          leaderSignature,
        });
        repo.audit(this.db, 'trade', detail, { positionId, attempt });
        out.failed++;
        continue;
      }

      if (result === 'no-position') {
        this.clearExitQueue(positionId);
        out.skipped++;
        continue;
      }
      if (result.kind === 'filled') {
        this.clearExitQueue(positionId);
        repo.audit(
          this.db,
          'trade',
          full
            ? 'exit queue retry filled; position closed'
            : 'exit queue retry filled; position partially closed',
          {
            positionId,
            mint: position.mint,
            attempt,
          },
        );
        out.filled++;
        if (intent.kind === 'fire_close' || closeReason === 'fire_close_all') {
          try {
            await this.callbacks.onFireCloseFilled?.(position.activationId);
          } catch (e) {
            repo.audit(
              this.db,
              'reconciliation',
              `exit-queue fire close filled but blocked-fire completion failed: ${(e as Error).message}`,
              { positionId, activationId: position.activationId },
            );
          }
        }
        this.callbacks.onStateChanged();
      } else if (result.kind === 'unknown') {
        this.clearExitQueue(positionId);
        repo.audit(this.db, 'trade', 'exit queue retry outcome unknown; reconciliation owns it', {
          positionId,
          mint: position.mint,
          attempt,
        });
        out.skipped++;
      } else if (result.kind === 'skipped') {
        this.queueExit(positionId, result.reason, {
          intentId: intent.intentId,
          exitBase,
          remainingBefore,
          remainingAfter,
          full,
          closeReason,
          leaderSignature,
        });
        repo.audit(this.db, 'trade', `exit queue retry skipped; queued again: ${result.reason}`, {
          positionId,
          attempt,
        });
        out.failed++;
      } else {
        repo.audit(this.db, 'trade', `exit queue retry failed; queued again: ${result.error}`, {
          positionId,
          attempt,
        });
        out.failed++;
      }
    }

    return out;
  }

  /** Warn (throttled) before the wallet runs out of fee headroom. */
  private lastLowSolAlertAt = 0;
  private alertLowSol(lamports: number): void {
    const now = Date.now();
    if (now - this.lastLowSolAlertAt < 3_600_000) return;
    this.lastLowSolAlertAt = now;
    repo.audit(this.db, 'trade', `wallet SOL low: ${(lamports / 1e9).toFixed(4)} SOL`, { lamports });
    void this.notifier
      .notify(`⚠️ Copydesk: wallet SOL is ${(lamports / 1e9).toFixed(4)} — exits still work but top up soon.`)
      .catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Intent execution + fills + PnL
  // ---------------------------------------------------------------------

  /** Re-check the seat and entry gates at the last moment before signing/submitting. */
  private assertCanSign(spec: IntentSpec): void {
    if (!spec.activationId) return;
    const activation = repo.getActivation(this.db, spec.activationId);
    if (!activation || activation.mode !== this.mode) {
      throw new Error('activation no longer belongs to this book');
    }
    if (spec.kind === 'entry') {
      if (activation.state !== 'ACTIVE') throw new Error(`activation is ${activation.state}`);
      if (this.liveMode && (!this.control.flags.armed || this.executor.mode !== 'live')) {
        throw new Error('live mode is not armed');
      }
      if (!this.control.entriesAllowed()) throw new Error('new entries are paused');
    }
  }

  private async runIntent(
    spec: IntentSpec,
    ctx: { activationId: string; candidateId: string; eventSignature: string | null },
    exit?: {
      positionId: string;
      exitBase: bigint;
      remainingAfter: bigint;
      full: boolean;
      closeReason: string;
    },
  ): Promise<ExecOutcome | null> {
    repo.recordAttempt(this.db, {
      intentId: spec.intentId,
      attemptNo: 1,
      phase: 'quote',
      requestRef: `${spec.inputMint}->${spec.outputMint}:${spec.inputAmountBase}`,
      responseRef: null,
      error: null,
      createdAt: new Date().toISOString(),
    });

    let quote: QuoteCheck;
    try {
      quote = await this.executor.quote(spec);
    } catch (e) {
      // A risk-reducing exit is not blocked by an advisory quote failure: the
      // executor re-quotes immediately before signing anyway.
      if (!exit) {
        const outcome: ExecOutcome = { kind: 'failed', error: `quote failed: ${(e as Error).message}` };
        repo.transitionIntent(this.db, spec.intentId, 'failed', { reason: outcome.error });
        return outcome;
      }
      quote = { slippageBps: 0, priceImpactBps: 0, minOutputBase: '0', source: 'assumed' };
    }

    // Slippage/impact gates apply to entries. Exits are risk-reducing; the
    // fresh min-out check in the executor still protects them.
    if (
      !exit &&
      (quote.priceImpactBps > this.risk.MAX_PRICE_IMPACT_BPS ||
        quote.slippageBps > this.risk.MAX_SLIPPAGE_BPS)
    ) {
      const rule =
        quote.priceImpactBps > this.risk.MAX_PRICE_IMPACT_BPS ? 'MAX_PRICE_IMPACT_BPS' : 'MAX_SLIPPAGE_BPS';
      repo.transitionIntent(this.db, spec.intentId, 'quote_rejected', {
        slippageBps: quote.slippageBps,
        priceImpactBps: quote.priceImpactBps,
        reason: `${rule} breach`,
      });
      repo.insertRiskRejection(this.db, {
        activationId: ctx.activationId,
        rule,
        limitValue: String(
          rule === 'MAX_SLIPPAGE_BPS' ? this.risk.MAX_SLIPPAGE_BPS : this.risk.MAX_PRICE_IMPACT_BPS,
        ),
        actualValue: String(rule === 'MAX_SLIPPAGE_BPS' ? quote.slippageBps : quote.priceImpactBps),
        detail: 'quote gate',
        createdAt: new Date().toISOString(),
      });
      return { kind: 'skipped', reason: `${rule} breach` };
    }

    repo.transitionIntent(this.db, spec.intentId, 'quoted', {
      slippageBps: quote.slippageBps,
      priceImpactBps: quote.priceImpactBps,
      minOutputBase: quote.minOutputBase,
      quoteJson: JSON.stringify(quote),
    });

    const live = this.executor.mode === 'live';
    if (live) repo.transitionIntent(this.db, spec.intentId, 'pending_sign');

    const hooks: ExecutionHooks = live
      ? {
          beforeSign: () => this.assertCanSign(spec),
          afterSign: (info: SignedTransactionInfo) => {
            repo.transitionIntent(this.db, spec.intentId, 'signed', {
              txSignature: info.signature,
              blockhash: info.blockhash,
              lastValidBlockHeight: info.lastValidBlockHeight,
              signedTxBase64: info.signedBase64,
              signedAt: new Date().toISOString(),
              buildKind: info.buildKind,
            });
          },
          afterSubmit: (info) => {
            repo.transitionIntent(this.db, spec.intentId, 'submitted', {
              submittedAt: new Date().toISOString(),
              submitVia: info.via,
            });
          },
        }
      : {};

    let outcome: ExecOutcome;
    try {
      outcome = await this.executor.execute(spec, quote, hooks);
    } catch (e) {
      const current = repo.getIntent(this.db, spec.intentId);
      const signature = current?.txSignature ?? null;
      const detail = `executor error: ${(e as Error).message}`;
      if (current && (current.state === 'signed' || current.state === 'submitted')) {
        repo.transitionIntent(this.db, spec.intentId, 'requires_reconciliation', { reason: detail });
        repo.insertReconciliationCase(this.db, {
          kind: 'unknown_execution',
          mode: this.mode,
          intentId: spec.intentId,
          positionId: exit?.positionId ?? null,
          signature,
          status: 'open',
          detail,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
        return { kind: 'unknown', detail, signature: signature ?? undefined };
      }
      repo.transitionIntent(this.db, spec.intentId, 'failed', { reason: detail });
      return { kind: 'failed', error: detail };
    }

    if (outcome.kind === 'skipped') {
      const current = repo.getIntent(this.db, spec.intentId);
      if (current?.state === 'quoted') {
        repo.transitionIntent(this.db, spec.intentId, 'skipped', { reason: outcome.reason });
      } else {
        repo.transitionIntent(this.db, spec.intentId, 'failed', { reason: outcome.reason });
      }
      return outcome;
    }
    if (outcome.kind === 'failed') {
      repo.transitionIntent(this.db, spec.intentId, 'failed', {
        reason: outcome.error,
        ...(outcome.signature ? { txSignature: outcome.signature } : {}),
      });
      return outcome;
    }
    if (outcome.kind === 'unknown') {
      const current = repo.getIntent(this.db, spec.intentId);
      const signature = outcome.signature ?? current?.txSignature ?? null;
      if (current?.state === 'quoted') {
        repo.transitionIntent(this.db, spec.intentId, 'pending_sign');
      }
      repo.transitionIntent(this.db, spec.intentId, 'requires_reconciliation', {
        reason: outcome.detail,
        txSignature: signature,
      });
      repo.insertReconciliationCase(this.db, {
        kind: 'unknown_execution',
        mode: this.mode,
        intentId: spec.intentId,
        positionId: exit?.positionId ?? null,
        signature,
        status: 'open',
        detail: outcome.detail,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      return outcome;
    }

    // Filled. Some injected executors (tests, custom runtimes) return a filled
    // outcome without invoking the afterSign/afterSubmit hooks; synthesize the
    // guarded path from the signature they returned so the state machine stays
    // the single authority.
    const beforeFill = repo.getIntent(this.db, spec.intentId);
    if (beforeFill?.state === 'pending_sign') {
      if (!outcome.signature) {
        repo.transitionIntent(this.db, spec.intentId, 'failed', {
          reason: 'executor returned filled without a signature',
        });
        return { kind: 'failed', error: 'executor returned filled without a signature' };
      }
      repo.transitionIntent(this.db, spec.intentId, 'signed', {
        txSignature: outcome.signature,
        signedAt: new Date().toISOString(),
      });
      repo.transitionIntent(this.db, spec.intentId, 'submitted', {
        submittedAt: new Date().toISOString(),
      });
    } else if (beforeFill?.state === 'signed') {
      repo.transitionIntent(this.db, spec.intentId, 'submitted', {
        submittedAt: new Date().toISOString(),
      });
    }
    repo.transitionIntent(this.db, spec.intentId, 'confirmed', {
      txSignature: outcome.signature,
      reason: null,
    });
    repo.recordAttempt(this.db, {
      intentId: spec.intentId,
      attemptNo: 2,
      phase: 'confirm',
      requestRef: null,
      responseRef: outcome.signature ?? 'paper',
      error: null,
      createdAt: new Date().toISOString(),
    });
    repo.insertFillIfAbsent(this.db, {
      fillId: 'fill_' + randomUUID(),
      intentId: spec.intentId,
      positionId: exit?.positionId ?? null,
      mode: this.mode,
      txSignature: outcome.signature,
      inputAmountBase: outcome.inputAmountBase,
      outputAmountBase: outcome.outputAmountBase,
      priceUsdMicro: null,
      feeEstimateUsdMicro: outcome.feeUsdMicro,
      balanceEvidenceJson: JSON.stringify(outcome.evidence),
      commitment: outcome.commitment,
      confirmedAt: new Date().toISOString(),
    });

    if (spec.kind === 'entry') {
      this.openPositionFromFill(spec, ctx, outcome);
    } else {
      await this.settleExitFromFill(spec, ctx, outcome, exit);
    }
    this.callbacks.onStateChanged();
    return outcome;
  }

  private openPositionFromFill(
    spec: IntentSpec,
    ctx: { activationId: string; candidateId: string; eventSignature: string | null },
    outcome: Extract<ExecOutcome, { kind: 'filled' }>,
  ): void {
    const activation = repo.getActivation(this.db, ctx.activationId);
    // The activation lock should make this impossible; if it happens anyway,
    // track the real tokens in a frozen row and surface a case instead of
    // stranding them outside the book.
    const frozen = !activation || activation.state !== 'ACTIVE' || activation.mode !== this.mode;
    // Pyramiding: a leader add into a mint we already hold updates the ONE
    // position for that mint (the mirrored-exit path assumes a single
    // position per candidate+mint) instead of opening a second one. Scoped to
    // THIS activation and this book — a new hire never inherits prior slots.
    const existing = repo.openPositionForMint(this.db, ctx.candidateId, spec.outputMint, this.mode);
    if (!frozen && existing && existing.activationId === ctx.activationId) {
      repo.updatePosition(this.db, existing.positionId, {
        inputUsdMicro: (BigInt(existing.inputUsdMicro) + BigInt(spec.inputUsdMicro)).toString(),
        remainingCostBasisUsdMicro: (
          BigInt(existing.remainingCostBasisUsdMicro) + BigInt(spec.inputUsdMicro)
        ).toString(),
        copiedTokenBase: (BigInt(existing.copiedTokenBase) + BigInt(outcome.outputAmountBase)).toString(),
        remainingTokenBase: (
          BigInt(existing.remainingTokenBase) + BigInt(outcome.outputAmountBase)
        ).toString(),
        feesUsdMicro: (BigInt(existing.feesUsdMicro) + BigInt(outcome.feeUsdMicro)).toString(),
        remainingFeesUsdMicro: (
          BigInt(existing.remainingFeesUsdMicro) + BigInt(outcome.feeUsdMicro)
        ).toString(),
      });
      const intent = repo.getIntent(this.db, spec.intentId);
      if (intent) repo.updateIntent(this.db, spec.intentId, { positionId: existing.positionId });
      repo.audit(this.db, 'trade', 'copied add filled (pyramided)', {
        positionId: existing.positionId,
        mint: spec.outputMint,
        usdMicro: spec.inputUsdMicro,
        mode: this.mode,
        signature: ctx.eventSignature,
      });
      return;
    }
    const positionId = 'pos_' + randomUUID();
    repo.insertPosition(this.db, {
      positionId,
      activationId: ctx.activationId,
      candidateId: ctx.candidateId,
      mode: this.mode,
      mint: spec.outputMint,
      mintSymbol: null,
      status: frozen ? 'requires_reconciliation' : 'open',
      entryIntentId: spec.intentId,
      inputMint: spec.inputMint,
      inputUsdMicro: spec.inputUsdMicro,
      remainingCostBasisUsdMicro: spec.inputUsdMicro,
      remainingFeesUsdMicro: outcome.feeUsdMicro,
      copiedTokenBase: outcome.outputAmountBase,
      remainingTokenBase: outcome.outputAmountBase,
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: outcome.feeUsdMicro,
      mintDecimals: spec.outputDecimals,
      inputDecimals: spec.inputDecimals,
      openedAt: new Date().toISOString(),
      closedAt: null,
      closeReason: null,
    });
    const intent = repo.getIntent(this.db, spec.intentId);
    if (intent) repo.updateIntent(this.db, spec.intentId, { positionId });
    if (frozen) {
      repo.insertReconciliationCase(this.db, {
        kind: 'late_fill',
        mode: this.mode,
        // Deliberately not linked by intent: resolveCasesForIntent must not
        // auto-close this case before the frozen position is flat.
        intentId: null,
        positionId,
        signature: outcome.signature,
        status: 'open',
        detail: `fill landed while activation was ${activation?.state ?? 'missing'} [activation:${ctx.activationId}] [intent:${spec.intentId}]`,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      repo.audit(this.db, 'reconciliation', 'late fill frozen for reconciliation', {
        positionId,
        activationId: ctx.activationId,
        signature: outcome.signature,
      });
    }
    repo.audit(this.db, 'trade', 'copied entry filled', {
      positionId,
      mint: spec.outputMint,
      usdMicro: spec.inputUsdMicro,
      mode: this.mode,
      signature: ctx.eventSignature,
    });
  }

  private async executeExit(
    positionId: string,
    exitBase: bigint,
    remainingAfter: bigint,
    full: boolean,
    closeReason: string,
    leaderSignature: string | null,
    opts: { allowFrozen?: boolean } = {},
  ): Promise<ExecOutcome | 'no-position'> {
    // Mirrored, code, retry and manual exits all serialize per position. The
    // retry consumer re-enters this lock and re-reads the position, so two
    // callers can never quote/sign the same remaining tokens.
    return this.locks.position(positionId, () =>
      this.executeExitLocked(positionId, exitBase, remainingAfter, full, closeReason, leaderSignature, opts),
    );
  }

  private async executeExitLocked(
    positionId: string,
    exitBase: bigint,
    remainingAfter: bigint,
    full: boolean,
    closeReason: string,
    leaderSignature: string | null,
    opts: { allowFrozen?: boolean } = {},
  ): Promise<ExecOutcome | 'no-position'> {
    const position = repo.getPosition(this.db, positionId);
    if (!position) return 'no-position';
    if (position.mode !== this.mode) {
      const detail = `exit refused: ${this.mode} book cannot close a ${position.mode} position`;
      repo.audit(this.db, 'monitor', `exit refused — ${detail}`, { positionId, mint: position.mint });
      return { kind: 'failed', error: detail };
    }
    // A frozen position may be settled only by a caller that has already
    // proved the exit is safe: the signature-less reconciliation retry and the
    // late-fill flattener pass `allowFrozen`. An agent/manual close does not,
    // so it cannot re-sell while an unknown exit is still ambiguous.
    if (position.status === 'requires_reconciliation' && !opts.allowFrozen) {
      const detail = 'frozen position: reconcile the ambiguous exit before submitting another close';
      repo.audit(this.db, 'monitor', `exit refused — ${detail}`, {
        positionId,
        mint: position.mint,
      });
      return { kind: 'failed', error: detail };
    }
    // `requires_reconciliation` with `allowFrozen` is the safe retry path.
    if (
      position.status !== 'open' &&
      position.status !== 'partially_closed' &&
      position.status !== 'requires_reconciliation'
    ) {
      return 'no-position';
    }

    // Sell what the wallet actually holds, never more. Recorded amounts come
    // from quoted outputs at entry and can exceed the delivered balance after
    // slippage; asking Jupiter for more fails with InsufficientFunds (6024).
    const remainingRecorded = BigInt(position.remainingTokenBase);
    const onChain = (await this.executor.availableBalance?.(position.mint).catch(() => null)) ?? null;
    // One position can never sell another chair's tokens: the wallet is shared
    // by every seat, so the on-chain balance is a ceiling, not this position's
    // share.
    if (exitBase > remainingRecorded) exitBase = remainingRecorded;
    if (onChain !== null && exitBase > onChain) {
      repo.audit(this.db, 'trade', 'exit clamped to on-chain balance', {
        positionId,
        requestedBase: exitBase.toString(),
        onChainBase: onChain.toString(),
      });
      exitBase = onChain;
    }
    // What THIS position still holds after the sale. The wallet's total balance
    // also counts other seats' tokens of the same mint, so it must not be used
    // here: it once inflated a position to 3.6× its real size after a partial
    // exit. A full close ends at zero regardless of delivery slippage.
    remainingAfter = remainingAfterForSale(remainingRecorded, exitBase, full);

    // Output notional estimation for the exit (token -> funding mint).
    const inputUsdEstimate = await this.estimateUsdMicroForTokens(
      position.mint,
      exitBase,
      position.mintDecimals,
    ).catch(() => 0n);
    const intentId = 'intent_' + randomUUID();

    // Nothing on chain to sell: record it and fail closed. The position stays
    // open (never silently "closed" without evidence); the caller's retry and
    // reconciliation guards surface it to the operator.
    if (exitBase <= 0n) {
      const detail = 'on-chain balance is 0 for this mint — nothing to sell';
      repo.insertIntent(this.db, {
        intentId,
        kind: full ? 'fire_close' : 'exit',
        mode: this.mode,
        activationId: position.activationId,
        candidateId: position.candidateId,
        positionId,
        mint: position.mint,
        inputMint: position.mint,
        inputAmountBase: '0',
        inputUsdMicro: '0',
        inputDecimals: position.mintDecimals,
        outputDecimals: position.inputDecimals,
        state: 'failed',
        reason: detail,
        idempotencyKey: `exit:${positionId}:0:${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.queueExit(positionId, detail, {
        intentId,
        exitBase,
        remainingBefore: remainingRecorded,
        remainingAfter,
        full,
        closeReason,
        leaderSignature,
      });
      repo.audit(this.db, 'trade', `exit skipped — ${detail}`, { positionId, mint: position.mint });
      return { kind: 'failed', error: detail };
    }

    const spec: IntentSpec = {
      intentId,
      activationId: position.activationId,
      kind: full
        ? closeReason === 'leader_exit' || closeReason === 'time_exit'
          ? 'exit'
          : 'fire_close'
        : 'exit',
      inputMint: position.mint,
      outputMint: position.inputMint,
      inputAmountBase: exitBase.toString(),
      inputDecimals: position.mintDecimals,
      outputDecimals: position.inputDecimals,
      inputUsdMicro: inputUsdEstimate.toString(),
      slippageBpsCap: exitSlippageBps(this.exitAttempt(positionId), [
        this.risk.EXIT_SLIPPAGE_BPS_1,
        this.risk.EXIT_SLIPPAGE_BPS_2,
        this.risk.EXIT_SLIPPAGE_BPS_3,
      ]),
      userPublicKey: this.walletPublicKey,
    };
    repo.insertIntent(this.db, {
      intentId,
      kind: spec.kind,
      mode: this.mode,
      activationId: position.activationId,
      candidateId: position.candidateId,
      positionId,
      mint: position.mint,
      inputMint: position.mint,
      inputAmountBase: exitBase.toString(),
      inputUsdMicro: inputUsdEstimate.toString(),
      inputDecimals: position.mintDecimals,
      outputDecimals: position.inputDecimals,
      state: 'pending_quote',
      idempotencyKey: `exit:${positionId}:${exitBase}:${Date.now()}`,
      reservedUsdMicro: '0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // A paper executor must not fill a live position, and a live executor must
    // not fill a paper one. No signature was sent, so the position stays open
    // and the chair is not frozen in reconciliation.
    if (guardExitMode(position.mode, this.executor.mode) === 'refuse') {
      const detail = `exit refused: ${this.executor.mode} executor cannot close a ${position.mode} position`;
      repo.transitionIntent(this.db, intentId, 'failed', { reason: detail });
      this.queueExit(positionId, detail, {
        intentId,
        exitBase,
        remainingBefore: remainingRecorded,
        remainingAfter,
        full,
        closeReason,
        leaderSignature,
      });
      repo.audit(this.db, 'monitor', `exit refused — ${detail}`, { positionId, mint: position.mint });
      return { kind: 'failed', error: detail };
    }

    // Fee headroom: a wallet this low on SOL cannot reliably pay swap fees and
    // account rent, so the swap would fail at preflight. Fail closed with an
    // explicit reason instead of producing a misleading reconciliation case.
    const solLamports = (await this.executor.availableSolLamports?.().catch(() => null)) ?? null;
    if (this.executor.mode === 'live' && solLamports !== null) {
      if (solLamports < MIN_SOL_FOR_FEES_LAMPORTS) {
        const detail = `insufficient SOL for fees: ${solLamports} lamports (need ${MIN_SOL_FOR_FEES_LAMPORTS}) — exit NOT sent`;
        repo.transitionIntent(this.db, intentId, 'failed', { reason: detail });
        this.queueExit(positionId, detail, {
          intentId,
          exitBase,
          remainingBefore: remainingRecorded,
          remainingAfter,
          full,
          closeReason,
          leaderSignature,
        });
        repo.audit(this.db, 'trade', `exit blocked — ${detail}`, { positionId });
        void this.notifier
          .notify(
            `⚠️ Copydesk: wallet SOL is ${(solLamports / 1e9).toFixed(4)} — too low to pay fees. Top up before exits will work.`,
          )
          .catch(() => {});
        return { kind: 'failed', error: detail };
      }
      if (solLamports < SOL_LOW_WATERMARK_LAMPORTS) this.alertLowSol(solLamports);
    }

    const ctx = {
      activationId: position.activationId,
      candidateId: position.candidateId,
      eventSignature: leaderSignature,
    };
    const outcome = await this.runIntent(spec, ctx, {
      positionId,
      exitBase,
      remainingAfter,
      full,
      closeReason,
    });
    if (!outcome) return { kind: 'failed', error: 'exit produced no outcome' };

    if (outcome.kind === 'unknown') {
      repo.updatePosition(this.db, positionId, { status: 'requires_reconciliation' });
      return outcome;
    }
    if (outcome.kind === 'failed') {
      // A pre-submission failure, or a chain-proven dead transaction, is safe
      // to retry. A chain failure with no token movement is also retryable; the
      // signature is archived in the intent reason so the queue guard can
      // remain "no signature = provably unsent".
      if (outcome.retryable === true || !outcome.signature) {
        const intent = repo.getIntent(this.db, intentId);
        if (intent?.txSignature) {
          repo.updateIntent(this.db, intentId, {
            txSignature: null,
            reason: `${outcome.error} (previous signature ${intent.txSignature} proved not landed)`,
          });
        }
        this.queueExit(positionId, outcome.error, {
          intentId,
          exitBase,
          remainingBefore: remainingRecorded,
          remainingAfter,
          full,
          closeReason,
          leaderSignature,
        });
      }
      return outcome;
    }
    return outcome;
  }

  private async settleExitFromFill(
    spec: IntentSpec,
    ctx: { activationId: string; candidateId: string; eventSignature: string | null },
    outcome: Extract<ExecOutcome, { kind: 'filled' }>,
    exit?: {
      positionId: string;
      exitBase: bigint;
      remainingAfter: bigint;
      full: boolean;
      closeReason: string;
    },
  ): Promise<void> {
    if (!exit) return;
    const position = repo.getPosition(this.db, exit.positionId);
    if (!position) return;

    const closedBase = exit.exitBase;
    const copiedTotal = BigInt(position.copiedTokenBase);
    const remainingTokens = BigInt(position.remainingTokenBase);
    // Release the cost basis that is actually still deployed. A partial close
    // must reduce `remaining_cost_basis` or the bankroll keeps charging the
    // full original input after half the position was sold.
    const priorLots = repo.listPnlLots(this.db, 10000).filter((l) => l.positionId === exit.positionId);
    const bookedCost = priorLots.reduce((sum, l) => sum + BigInt(l.costBasisUsdMicro), 0n);
    let remainingCostTotal = BigInt(position.remainingCostBasisUsdMicro);
    if (remainingCostTotal === 0n) {
      const fallback = BigInt(position.inputUsdMicro) - bookedCost;
      if (fallback > 0n) remainingCostTotal = fallback;
    }
    let remainingFeesTotal = BigInt(position.remainingFeesUsdMicro);
    if (remainingFeesTotal === 0n && copiedTotal > 0n) {
      remainingFeesTotal = (BigInt(position.feesUsdMicro) * remainingTokens) / copiedTotal;
    }
    const fullyClosed = exit.remainingAfter <= 0n;
    const proportionalCost = remainingTokens > 0n ? (remainingCostTotal * closedBase) / remainingTokens : 0n;
    const costBasis = fullyClosed
      ? remainingCostTotal
      : proportionalCost > remainingCostTotal
        ? remainingCostTotal
        : proportionalCost;
    const feeShare = remainingTokens > 0n ? (remainingFeesTotal * closedBase) / remainingTokens : 0n;
    // Proceeds in USD micro from the funding mint received.
    let proceedsUsdMicro: bigint;
    if (position.inputMint === USDC_MINT || position.inputMint === USDT_MINT) {
      proceedsUsdMicro = BigInt(outcome.outputAmountBase);
    } else {
      const price = await this.prices.priceOf(position.inputMint, position.inputDecimals).catch(() => null);
      proceedsUsdMicro = price
        ? (BigInt(outcome.outputAmountBase) * price.priceUsdMicro) / 10n ** BigInt(position.inputDecimals)
        : BigInt(spec.inputUsdMicro);
    }
    // Fees are paid in SOL from the fee reserve, NOT out of USDC capital: the
    // equity ledger is USDC-only, so PnL = proceeds − cost basis and the fee
    // estimate is kept as informational context on the lot (the real SOL spend
    // is measured by the fee ledger and shown separately on the dashboard).
    const fees = BigInt(outcome.feeUsdMicro) + feeShare;
    const pnl = proceedsUsdMicro - costBasis;

    repo.insertPnlLot(this.db, {
      positionId: exit.positionId,
      mode: this.mode,
      closedBase: closedBase.toString(),
      proceedsUsdMicro: proceedsUsdMicro.toString(),
      costBasisUsdMicro: costBasis.toString(),
      feesUsdMicro: fees.toString(),
      pnlUsdMicro: pnl.toString(),
      unitType: exit.full ? 'position_closed' : 'partial_close',
      closedAt: new Date().toISOString(),
      signature: ctx.eventSignature,
    });

    const newRemaining = exit.remainingAfter;
    const realizedTotal = BigInt(position.realizedPnlUsdMicro) + pnl;
    const remainingCostAfter = remainingCostTotal - costBasis;
    const remainingFeesAfter = remainingFeesTotal - feeShare;
    repo.updatePosition(this.db, exit.positionId, {
      remainingTokenBase: newRemaining.toString(),
      remainingCostBasisUsdMicro: (remainingCostAfter > 0n ? remainingCostAfter : 0n).toString(),
      remainingFeesUsdMicro: (remainingFeesAfter > 0n ? remainingFeesAfter : 0n).toString(),
      realizedPnlUsdMicro: realizedTotal.toString(),
      status: newRemaining <= 0n ? 'closed' : 'partially_closed',
      closedAt: newRemaining <= 0n ? new Date().toISOString() : null,
      closeReason: newRemaining <= 0n ? exit.closeReason : null,
    });

    // Loss-streak units.
    const activation = repo.getActivation(this.db, ctx.activationId);
    if (!activation) return;
    const unitType: 'position_closed' | 'partial_close' = exit.full ? 'position_closed' : 'partial_close';
    const streakCfg = {
      unit: this.risk.LOSS_STREAK_UNIT,
      fireAfter: this.risk.FIRE_AFTER_CONSECUTIVE_LOSSES,
      breakevenResets: this.risk.BREAKEVEN_RESETS_STREAK,
    };
    if (!countsAsUnit(unitType, streakCfg)) return;
    const result = applyCloseUnit(activation.lossStreak, pnl, streakCfg);
    repo.insertStreakEvent(this.db, {
      activationId: ctx.activationId,
      unitType,
      unitRef: exit.positionId,
      result: result.unitResult,
      pnlUsdMicro: pnl.toString(),
      streakAfter: result.streak,
      createdAt: new Date().toISOString(),
    });
    repo.updateActivation(this.db, ctx.activationId, { lossStreak: result.streak });

    // Only an ACTIVE chair fires on a loss streak. A close-out of a firing or
    // reconciliation-blocked seat produces losing units too; those must not
    // schedule a second fire — completeBlockedFire is the only completion path.
    if (result.fired && activation.state === 'ACTIVE') {
      this.callbacks.onFired(ctx.activationId, ctx.candidateId, 'two consecutive losing units');
    }
  }

  /**
   * Reconcile every signed/submitted intent against chain evidence. This is
   * the only path that may turn `requires_reconciliation` into confirmed or
   * failed. It runs at boot and on the runtime's reconciliation timer.
   */
  async reconcileSignedIntents(
    reader: ReconciliationReader,
    nowMs = Date.now(),
  ): Promise<{
    reviewed: number;
    confirmed: number;
    failed: number;
    pending: number;
    lateFillsClosed: number;
  }> {
    const out = { reviewed: 0, confirmed: 0, failed: 0, pending: 0, lateFillsClosed: 0 };

    // A late fill is a confirmed entry whose seat was no longer ACTIVE. The
    // position is real and frozen; flatten it with a normal exit and resolve
    // the case once the book is flat. This is risk-reducing, never a re-sign.
    for (const c of repo.openReconciliationCases(this.db, this.mode)) {
      if (c.kind !== 'late_fill' || !c.positionId) continue;
      const position = repo.getPosition(this.db, c.positionId);
      if (!position) {
        repo.resolveReconciliationCase(this.db, c.id);
        continue;
      }
      if (position.status === 'closed') {
        repo.resolveReconciliationCase(this.db, c.id);
        continue;
      }
      // Never re-close while an exit outcome is still ambiguous: an unknown
      // exit with a signature must be reconciled first or this loop could
      // double-sell. A separate case or signed intent for the position means
      // "wait for the reconciler"; a failed/dead outcome clears it next pass.
      const otherCase = repo
        .openReconciliationCases(this.db, this.mode)
        .some((other) => other.id !== c.id && other.positionId === c.positionId);
      const exitInFlight = repo.signedIntents(this.db, this.mode).some((i) => i.positionId === c.positionId);
      if (otherCase || exitInFlight) continue;
      const result = await this.closePosition(c.positionId, 'late_fill_close', {
        allowFrozen: true,
      });
      if (result === 'closed') {
        repo.resolveReconciliationCase(this.db, c.id);
        repo.audit(this.db, 'reconciliation', 'late fill closed and case resolved', {
          positionId: c.positionId,
          caseId: c.id,
        });
        out.lateFillsClosed++;
      }
    }

    // A crash before signing leaves pending_quote/quoted/pending_sign. The new
    // writer persists `signed` before the send, so these are provably unsent.
    for (const stale of repo.stalePreSignIntents(
      this.db,
      new Date(nowMs - 5 * 60_000).toISOString(),
      this.mode,
    )) {
      if (stale.txSignature) continue;
      const current = repo.getIntent(this.db, stale.intentId);
      if (
        !current ||
        ['confirmed', 'failed', 'skipped', 'cancelled', 'quote_rejected'].includes(current.state)
      ) {
        continue;
      }
      repo.transitionIntent(this.db, stale.intentId, 'failed', {
        reason: 'stale pre-sign intent recovered after restart (never signed)',
      });
      repo.audit(this.db, 'reconciliation', 'stale pre-sign intent marked failed', {
        intentId: stale.intentId,
        state: stale.state,
      });
      out.failed++;
    }

    for (const intent of repo.signedIntents(this.db, this.mode)) {
      out.reviewed++;
      const signature = intent.txSignature;
      if (!signature) continue;
      const status = await reader.signatureStatus(signature);
      if (status === null) {
        // The status read failed. Not the same as "not found": leave it alone.
        out.pending++;
        continue;
      }
      if (status.found) {
        const settled =
          status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
        if (!settled) {
          out.pending++;
          continue;
        }
        const detail = await reader.transactionDetail(signature, this.walletPublicKey ?? '');
        if (!detail) {
          out.pending++;
          continue;
        }
        if (detail.err != null) {
          this.failReconciledIntent(intent, signature, `on-chain failure: ${JSON.stringify(detail.err)}`);
          out.failed++;
        } else {
          const applied = await this.applyReconciledIntent(intent, detail, signature);
          if (applied) out.confirmed++;
          else out.pending++;
        }
        continue;
      }

      const height = await reader.blockHeight();
      if (
        intent.lastValidBlockHeight !== null &&
        height !== null &&
        height > intent.lastValidBlockHeight + 150
      ) {
        this.failReconciledIntent(intent, signature, 'transaction expired without landing');
        out.failed++;
      } else {
        out.pending++;
      }
    }
    return out;
  }

  private async applyReconciledIntent(
    intent: NonNullable<ReturnType<typeof repo.getIntent>>,
    detail: ChainTransactionDetail,
    signature: string,
  ): Promise<boolean> {
    const current = repo.getIntent(this.db, intent.intentId);
    if (!current || current.state === 'confirmed') return true;
    if (current.state === 'signed' || current.state === 'submitted') {
      repo.transitionIntent(this.db, intent.intentId, 'requires_reconciliation', {
        reason: 'chain-confirmed transaction reconciled',
        txSignature: signature,
      });
    }
    const spec = this.specFromIntent(intent);
    const fillBase = {
      fillId: 'fill_' + randomUUID(),
      intentId: intent.intentId,
      mode: this.mode,
      txSignature: signature,
      priceUsdMicro: null,
      feeEstimateUsdMicro: usdToMicro(0.0015).toString(),
      balanceEvidenceJson: JSON.stringify({
        signature,
        slot: detail.slot,
        reconciled: true,
        tokenDeltas: Object.fromEntries(
          Object.entries(detail.tokenDeltas).map(([mint, delta]) => [
            mint,
            { pre: delta.pre.toString(), post: delta.post.toString() },
          ]),
        ),
      }),
      commitment: 'confirmed',
      confirmedAt: new Date().toISOString(),
    };

    if (intent.kind === 'entry') {
      if (!intent.activationId || !intent.candidateId) {
        repo.resolveIntentWithEvidence(this.db, intent.intentId, 'failed', {
          reason: 'reconciled entry is missing its activation/candidate',
          txSignature: signature,
        });
        this.resolveCasesForIntent(intent.intentId);
        return false;
      }
      const output = detail.tokenDeltas[intent.mint];
      const received = output && output.post > output.pre ? output.post - output.pre : 0n;
      if (received <= 0n) {
        repo.audit(this.db, 'reconciliation', 'entry landed but no output token delta was readable', {
          intentId: intent.intentId,
          signature,
        });
        return false;
      }
      repo.resolveIntentWithEvidence(this.db, intent.intentId, 'confirmed', { txSignature: signature });
      repo.insertFillIfAbsent(this.db, {
        ...fillBase,
        positionId: null,
        inputAmountBase: intent.inputAmountBase,
        outputAmountBase: received.toString(),
      });
      this.openPositionFromFill(
        spec,
        {
          activationId: intent.activationId,
          candidateId: intent.candidateId,
          eventSignature: null,
        },
        {
          kind: 'filled',
          signature,
          inputAmountBase: intent.inputAmountBase,
          outputAmountBase: received.toString(),
          feeUsdMicro: usdToMicro(0.0015).toString(),
          evidence: { signature, reconciled: true },
          commitment: 'confirmed',
        },
      );
      this.resolveCasesForIntent(intent.intentId);
      this.callbacks.onStateChanged();
      return true;
    }

    if (!intent.positionId) {
      repo.resolveIntentWithEvidence(this.db, intent.intentId, 'failed', {
        reason: 'reconciled exit has no position',
        txSignature: signature,
      });
      this.resolveCasesForIntent(intent.intentId);
      return false;
    }
    const position = repo.getPosition(this.db, intent.positionId);
    if (!position) {
      repo.resolveIntentWithEvidence(this.db, intent.intentId, 'failed', {
        reason: 'reconciled exit position is missing',
        txSignature: signature,
      });
      this.resolveCasesForIntent(intent.intentId);
      return false;
    }
    const tokenDelta = detail.tokenDeltas[position.mint];
    const sold =
      tokenDelta && tokenDelta.pre > tokenDelta.post
        ? tokenDelta.pre - tokenDelta.post
        : BigInt(intent.inputAmountBase);
    const remainingBefore = BigInt(position.remainingTokenBase);
    const full = intent.kind === 'fire_close' || sold >= remainingBefore;
    const remainingAfter = full ? 0n : remainingBefore - sold;
    let outputAmountBase = '0';
    if (position.inputMint === SOL_MINT) {
      // The native delta is net of the network fee and tip; add them back so
      // the settlement books the SOL the swap actually produced.
      const received = detail.solLamportsDelta + BigInt(detail.feeLamports) + BigInt(detail.tipLamports);
      outputAmountBase = (received > 0n ? received : 0n).toString();
    } else {
      const outDelta = detail.tokenDeltas[position.inputMint];
      outputAmountBase =
        outDelta && outDelta.post > outDelta.pre ? (outDelta.post - outDelta.pre).toString() : '0';
    }
    repo.resolveIntentWithEvidence(this.db, intent.intentId, 'confirmed', { txSignature: signature });
    repo.insertFillIfAbsent(this.db, {
      ...fillBase,
      positionId: intent.positionId,
      inputAmountBase: sold.toString(),
      outputAmountBase,
    });
    await this.settleExitFromFill(
      spec,
      {
        activationId: position.activationId,
        candidateId: position.candidateId,
        eventSignature: null,
      },
      {
        kind: 'filled',
        signature,
        inputAmountBase: sold.toString(),
        outputAmountBase,
        feeUsdMicro: usdToMicro(0.0015).toString(),
        evidence: { signature, reconciled: true },
        commitment: 'confirmed',
      },
      {
        positionId: intent.positionId,
        exitBase: sold,
        remainingAfter,
        full,
        closeReason: 'reconciled_exit',
      },
    );
    this.resolveCasesForIntent(intent.intentId);
    if (intent.kind === 'fire_close') {
      await this.callbacks.onFireCloseFilled?.(position.activationId);
    }
    this.callbacks.onStateChanged();
    return true;
  }

  private failReconciledIntent(
    intent: NonNullable<ReturnType<typeof repo.getIntent>>,
    signature: string,
    reason: string,
  ): void {
    const current = repo.getIntent(this.db, intent.intentId);
    if (current && (current.state === 'signed' || current.state === 'submitted')) {
      repo.transitionIntent(this.db, intent.intentId, 'requires_reconciliation', {
        reason,
        txSignature: signature,
      });
    }
    const latest = repo.getIntent(this.db, intent.intentId);
    if (latest?.state === 'requires_reconciliation') {
      repo.resolveIntentWithEvidence(this.db, intent.intentId, 'failed', {
        reason: `${reason} (signature ${signature})`,
        txSignature: signature,
      });
    }
    if (intent.positionId) {
      const position = repo.getPosition(this.db, intent.positionId);
      if (position?.status === 'requires_reconciliation' && BigInt(position.remainingTokenBase) > 0n) {
        repo.updatePosition(this.db, position.positionId, { status: 'open' });
      }
    }
    this.resolveCasesForIntent(intent.intentId);
    repo.audit(this.db, 'reconciliation', `intent failed after chain check: ${reason}`, {
      intentId: intent.intentId,
      signature,
    });
    this.callbacks.onStateChanged();
  }

  private resolveCasesForIntent(intentId: string): void {
    for (const c of repo.openReconciliationCases(this.db, this.mode)) {
      if (c.intentId === intentId) repo.resolveReconciliationCase(this.db, c.id);
    }
  }

  private specFromIntent(intent: NonNullable<ReturnType<typeof repo.getIntent>>): IntentSpec {
    return {
      intentId: intent.intentId,
      activationId: intent.activationId ?? undefined,
      kind: intent.kind as IntentSpec['kind'],
      inputMint: intent.inputMint,
      outputMint: intent.mint,
      inputAmountBase: intent.inputAmountBase,
      inputDecimals: intent.inputDecimals,
      outputDecimals: intent.outputDecimals,
      inputUsdMicro: intent.inputUsdMicro ?? '0',
      slippageBpsCap: this.risk.MAX_SLIPPAGE_BPS,
      userPublicKey: this.walletPublicKey,
    };
  }

  private async estimateUsdMicroForTokens(mint: string, base: bigint, decimals = 6): Promise<bigint> {
    if (mint === USDC_MINT || mint === USDT_MINT) return base;
    const price = await this.prices.priceOf(mint, decimals);
    return (base * price.priceUsdMicro) / 10n ** BigInt(decimals);
  }
}
