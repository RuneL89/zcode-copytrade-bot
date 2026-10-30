import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import type { PriceProvider } from '@zcode-bot/providers';
import {
  applyCloseUnit,
  bankrollHeadroom,
  capToHeadroom,
  classifyLeaderEvent,
  computeCopyNotional,
  countsAsUnit,
  evaluateEntryRisk,
  isEventTooOld,
  leaderSoldFraction,
  planCopiedExit,
  stringifyBigIntSafe,
  usdToMicro,
  type LeaderClassifiedEvent,
  type LeaderTxSummary,
} from '@zcode-bot/core';
import type { Executor, ExecOutcome, IntentSpec, QuoteCheck } from './executors.js';
import { MIN_SOL_FOR_FEES_LAMPORTS, SOL_LOW_WATERMARK_LAMPORTS } from './executors.js';
import type { ControlService } from './control.js';
import type { Notifier } from '@zcode-bot/providers';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Close-out attempts per position during a fire (pre-submission failures only). */
const CLOSE_ATTEMPTS = 3;
const CLOSE_BACKOFF_MS = 800;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EngineCallbacks {
  /** Called when a close unit pushes the streak to the fire threshold. */
  onFired: (activationId: string, candidateId: string, reason: string) => void;
  /** Called after every state-changing engine action (rebuild dashboard state). */
  onStateChanged: () => void;
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
    /**
     * Real bankroll (live): USDC cash and capital (cash + open position cost)
     * from the latest wallet refresh. When it returns null (or is absent,
     * paper) the modelled equityStart+realized bankroll is used instead.
     */
    private realBankroll?: () => { cashUsdMicro: bigint; capitalUsdMicro: bigint } | null,
  ) {}

  setRisk(risk: RiskConfig): void {
    this.risk = risk;
  }

  // ---------------------------------------------------------------------
  // Leader events
  // ---------------------------------------------------------------------

  async handleLeaderTx(activationId: string, candidateId: string, summary: LeaderTxSummary): Promise<void> {
    // Only an ACTIVE trader's events are processed; FIRING/FIRED/RECONCILING
    // activations accept no new entries (exits for pending closes are handled
    // by the lifecycle's own close paths).
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state !== 'ACTIVE') return;

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
    this.callbacks.onStateChanged();
  }

  private async handleLeaderBuy(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_buy' }>,
  ): Promise<void> {
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

    // Measure leader input notional from the funding leg with fresh pricing.
    let leaderInputUsdMicro: bigint;
    let inputMint: string;
    let inputDecimals: number;
    let inputAmountBase: bigint;
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
      leaderInputUsdMicro = (inputAmountBase * price.priceUsdMicro) / 10n ** 9n;
    }

    const sizing = computeCopyNotional({
      leaderInputUsdMicro,
      scaleNumerator: BigInt(Math.round(this.risk.COPY_SCALE * 10000)),
      scaleDenominator: 10000n,
      minPerBuyUsdMicro: usdToMicro(this.risk.MIN_PER_BUY_USD),
      maxPerBuyUsdMicro: usdToMicro(this.risk.MAX_PER_BUY_USD),
      allowBelowMinRoundUp: false,
    });

    const intentId = 'intent_' + randomUUID();
    const idempotencyKey = `entry:${activationId}:${event.signature}:${event.mint}`;

    if (sizing.action !== 'copy') {
      repo.insertIntent(this.db, {
        intentId,
        kind: 'entry',
        mode: this.executor.mode,
        activationId,
        candidateId,
        positionId: null,
        mint: event.mint,
        inputMint,
        inputAmountBase: '0',
        inputUsdMicro: sizing.desiredUsdMicro.toString(),
        state: 'skipped',
        idempotencyKey,
        reason:
          sizing.action === 'skip_below_min' ? 'below MIN_PER_BUY_USD (not rounded up)' : 'invalid input',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'MIN_PER_BUY_USD',
        limitValue: String(this.risk.MIN_PER_BUY_USD),
        actualValue: (Number(sizing.desiredUsdMicro) / 1e6).toFixed(2),
        detail: `desired copy notional below minimum; leader input ${(Number(leaderInputUsdMicro) / 1e6).toFixed(2)} USD`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Bankroll step: deployed (open entries INCL. entry fees) may not exceed
    // MAX_DEPLOYED_PCT of capital. Live gates on the REAL wallet (USDC cash +
    // open position cost, from the last wallet refresh): before the first
    // read has landed there is no real number, and the modelled bankroll must
    // never gate a live order — the entry is skipped instead. Paper keeps the
    // modelled equityStart + realized bankroll.
    const openAll = repo.openPositions(this.db);
    // Fail closed only when a bankroll provider IS configured (production live)
    // but has no data yet. No provider at all (tests) keeps the modelled path.
    const real = this.liveMode && this.realBankroll ? (this.realBankroll() ?? null) : null;
    if (this.liveMode && this.realBankroll && !real) {
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'WALLET_BANKROLL_UNKNOWN',
        limitValue: '0',
        actualValue: '0',
        detail: 'live entry before the first wallet refresh — no real bankroll yet',
        createdAt: new Date().toISOString(),
      });
      return;
    }
    const bank = real
      ? bankrollHeadroom({
          equityStartUsdMicro: real.capitalUsdMicro,
          openEntriesUsdMicro: real.capitalUsdMicro - real.cashUsdMicro,
          openFeesUsdMicro: 0n,
          realizedNetUsdMicro: 0n,
          maxDeployedPct: this.risk.MAX_DEPLOYED_PCT,
        })
      : bankrollHeadroom({
          equityStartUsdMicro: this.equityStartUsdMicro,
          openEntriesUsdMicro: openAll.reduce((acc, p) => acc + BigInt(p.inputUsdMicro), 0n),
          openFeesUsdMicro: openAll.reduce((acc, p) => acc + BigInt(p.feesUsdMicro), 0n),
          realizedNetUsdMicro: repo.realizedPnlSince(this.db, '1970-01-01T00:00:00.000Z'),
          maxDeployedPct: this.risk.MAX_DEPLOYED_PCT,
        });
    const capped = capToHeadroom(
      sizing.finalUsdMicro!,
      bank.headroomUsdMicro,
      usdToMicro(this.risk.MIN_PER_BUY_USD),
    );
    if (capped.action === 'skip_headroom') {
      repo.insertIntent(this.db, {
        intentId,
        kind: 'entry',
        mode: this.executor.mode,
        activationId,
        candidateId,
        positionId: null,
        mint: event.mint,
        inputMint,
        inputAmountBase: '0',
        inputUsdMicro: sizing.finalUsdMicro!.toString(),
        state: 'skipped',
        idempotencyKey,
        reason: 'MAX_DEPLOYED_PCT: bankroll cap',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      repo.insertRiskRejection(this.db, {
        activationId,
        rule: 'MAX_DEPLOYED_PCT',
        limitValue: bank.headroomUsdMicro.toString(),
        actualValue: sizing.finalUsdMicro!.toString(),
        detail: `bankroll cap: ${(Number(bank.deployedUsdMicro) / 1e6).toFixed(2)} of ${(
          Number(bank.capitalUsdMicro) / 1e6
        ).toFixed(2)} deployed, headroom ${(Number(bank.headroomUsdMicro) / 1e6).toFixed(2)}`,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    const notional = capped.finalUsdMicro;

    // Convert notional to input token base units.
    let amountBase: bigint;
    if (inputMint === USDC_MINT || inputMint === USDT_MINT) {
      amountBase = notional; // micro-USD == base units of 6-dec stables
    } else {
      const price = await this.prices.priceOf(inputMint, inputDecimals);
      amountBase = (notional * 10n ** BigInt(inputDecimals)) / price.priceUsdMicro;
      if (amountBase <= 0n) {
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

    const dayStart = new Date(new Date().toISOString().slice(0, 10)).toISOString();
    const decision = evaluateEntryRisk(this.risk, {
      entryUsdMicro: notional,
      realizedPnlTodayUsdMicro: repo.realizedPnlSince(this.db, dayStart),
      eventAgeSeconds: Math.max(0, Math.round((Date.now() - event.blockTime * 1000) / 1000)),
      priceAgeSeconds: 0,
      leaderboardAgeSeconds: 0,
      quoteSlippageBps: null,
      quotePriceImpactBps: null,
    });
    if (!decision.allowed) {
      repo.insertIntent(this.db, {
        intentId,
        kind: 'entry',
        mode: this.executor.mode,
        activationId,
        candidateId,
        positionId: null,
        mint: event.mint,
        inputMint,
        inputAmountBase: amountBase.toString(),
        inputUsdMicro: notional.toString(),
        state: 'skipped',
        idempotencyKey,
        reason: `${decision.rule}: ${decision.detail}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
      repo.insertIntent(this.db, {
        intentId,
        kind: 'entry',
        mode: 'live',
        activationId,
        candidateId,
        positionId: null,
        mint: event.mint,
        inputMint,
        inputAmountBase: '0',
        inputUsdMicro: sizing.finalUsdMicro!.toString(),
        state: 'skipped',
        idempotencyKey,
        reason: this.control.flags.armed ? 'wallet locked: live executor not mounted' : 'live mode not armed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    // Entry gates: pause/emergency.
    if (!this.control.entriesAllowed()) {
      repo.insertIntent(this.db, {
        intentId,
        kind: 'entry',
        mode: this.executor.mode,
        activationId,
        candidateId,
        positionId: null,
        mint: event.mint,
        inputMint,
        inputAmountBase: amountBase.toString(),
        inputUsdMicro: notional.toString(),
        state: 'skipped',
        idempotencyKey,
        reason: this.control.flags.emergencyStopped
          ? 'EMERGENCY STOP'
          : this.control.withdrawInFlight
            ? 'withdrawal in progress'
            : 'new entries paused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const spec: IntentSpec = {
      intentId,
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

    // Persist the intent BEFORE any quote/sign (audit-first).
    repo.insertIntent(this.db, {
      intentId,
      kind: 'entry',
      mode: this.executor.mode,
      activationId,
      candidateId,
      positionId: null,
      mint: event.mint,
      inputMint,
      inputAmountBase: amountBase.toString(),
      inputUsdMicro: notional.toString(),
      state: 'pending_quote',
      idempotencyKey,
      slippageBps: null,
      priceImpactBps: null,
      reason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await this.runIntent(spec, { activationId, candidateId, eventSignature: event.signature });
  }

  private async handleLeaderSell(
    activationId: string,
    candidateId: string,
    summary: LeaderTxSummary,
    event: Extract<LeaderClassifiedEvent, { kind: 'swap_sell' }>,
  ): Promise<void> {
    // Mirrored exits continue even when new entries are paused.
    const position = repo.openPositionForMint(this.db, candidateId, event.mint);
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

  /** Close the entire remaining position (fire policy / close-all / emergency). */
  async closePosition(positionId: string, reason: string): Promise<'closed' | 'unknown' | 'failed'> {
    const position = repo.getPosition(this.db, positionId);
    if (!position) return 'failed';
    const remaining = BigInt(position.remainingTokenBase);
    if (remaining <= 0n) return 'closed';
    const out = await this.executeExit(positionId, remaining, 0n, true, reason, null);
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
    const positions = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
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

  /** Warn (throttled) before the wallet runs out of fee headroom. */
  private lastLowSolAlertAt = 0;
  private alertLowSol(lamports: number): void {
    const now = Date.now();
    if (now - this.lastLowSolAlertAt < 3_600_000) return;
    this.lastLowSolAlertAt = now;
    repo.audit(this.db, 'trade', `wallet SOL low: ${(lamports / 1e9).toFixed(4)} SOL`, { lamports });
    void this.notifier
      .notify(
        `⚠️ ZCode Bot: wallet SOL is ${(lamports / 1e9).toFixed(4)} — exits still work but top up soon.`,
      )
      .catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Intent execution + fills + PnL
  // ---------------------------------------------------------------------

  private async runIntent(
    spec: IntentSpec,
    ctx: { activationId: string; candidateId: string; eventSignature: string | null },
  ): Promise<void> {
    const attemptNo = repo.recordAttempt(this.db, {
      intentId: spec.intentId,
      attemptNo: 1,
      phase: 'quote',
      requestRef: `${spec.inputMint}->${spec.outputMint}:${spec.inputAmountBase}`,
      responseRef: null,
      error: null,
      createdAt: new Date().toISOString(),
    });
    void attemptNo;

    let quote: QuoteCheck;
    try {
      quote = await this.executor.quote(spec);
    } catch (e) {
      repo.updateIntent(this.db, spec.intentId, {
        state: 'failed',
        reason: `quote failed: ${(e as Error).message}`,
      });
      return;
    }

    // Slippage/impact gates on the actual quote.
    if (
      quote.priceImpactBps > this.risk.MAX_PRICE_IMPACT_BPS ||
      quote.slippageBps > this.risk.MAX_SLIPPAGE_BPS
    ) {
      const rule =
        quote.priceImpactBps > this.risk.MAX_PRICE_IMPACT_BPS ? 'MAX_PRICE_IMPACT_BPS' : 'MAX_SLIPPAGE_BPS';
      repo.updateIntent(this.db, spec.intentId, {
        state: 'quote_rejected',
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
      return;
    }

    repo.updateIntent(this.db, spec.intentId, {
      state: 'quoted',
      slippageBps: quote.slippageBps,
      priceImpactBps: quote.priceImpactBps,
      minOutputBase: quote.minOutputBase,
      quoteJson: JSON.stringify(quote),
    });

    let outcome: ExecOutcome;
    try {
      outcome = await this.executor.execute(spec, quote);
    } catch (e) {
      repo.updateIntent(this.db, spec.intentId, {
        state: 'requires_reconciliation',
        reason: `executor error: ${(e as Error).message}`,
      });
      repo.insertReconciliationCase(this.db, {
        kind: 'unknown_execution',
        intentId: spec.intentId,
        positionId: null,
        signature: null,
        status: 'open',
        detail: (e as Error).message,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      return;
    }

    if (outcome.kind === 'skipped') {
      repo.updateIntent(this.db, spec.intentId, { state: 'skipped', reason: outcome.reason });
      return;
    }
    if (outcome.kind === 'failed') {
      repo.updateIntent(this.db, spec.intentId, { state: 'failed', reason: outcome.error });
      return;
    }
    if (outcome.kind === 'unknown') {
      // Submitted/signed with unknown outcome: reconcile, never blind-retry.
      repo.updateIntent(this.db, spec.intentId, { state: 'requires_reconciliation', reason: outcome.detail });
      repo.insertReconciliationCase(this.db, {
        kind: 'unknown_execution',
        intentId: spec.intentId,
        positionId: null,
        signature: null,
        status: 'open',
        detail: outcome.detail,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      return;
    }

    // Filled.
    repo.updateIntent(this.db, spec.intentId, {
      state: 'confirmed',
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
    repo.insertFill(this.db, {
      fillId: 'fill_' + randomUUID(),
      intentId: spec.intentId,
      positionId: null,
      mode: this.executor.mode,
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
      await this.settleExitFromFill(spec, ctx, outcome);
    }
    this.callbacks.onStateChanged();
  }

  private openPositionFromFill(
    spec: IntentSpec,
    ctx: { activationId: string; candidateId: string; eventSignature: string | null },
    outcome: Extract<ExecOutcome, { kind: 'filled' }>,
  ): void {
    // Pyramiding: a leader add into a mint we already hold updates the ONE
    // position for that mint (the mirrored-exit path assumes a single
    // position per candidate+mint) instead of opening a second one. Scoped to
    // THIS activation — a new hire never inherits the previous hire's slots.
    const existing = repo.openPositionForMint(this.db, ctx.candidateId, spec.outputMint);
    if (existing && existing.activationId === ctx.activationId) {
      repo.updatePosition(this.db, existing.positionId, {
        inputUsdMicro: (BigInt(existing.inputUsdMicro) + BigInt(spec.inputUsdMicro)).toString(),
        copiedTokenBase: (BigInt(existing.copiedTokenBase) + BigInt(outcome.outputAmountBase)).toString(),
        remainingTokenBase: (
          BigInt(existing.remainingTokenBase) + BigInt(outcome.outputAmountBase)
        ).toString(),
        feesUsdMicro: (BigInt(existing.feesUsdMicro) + BigInt(outcome.feeUsdMicro)).toString(),
      });
      const intent = repo.getIntent(this.db, spec.intentId);
      if (intent) repo.updateIntent(this.db, spec.intentId, { positionId: existing.positionId });
      repo.audit(this.db, 'trade', 'copied add filled (pyramided)', {
        positionId: existing.positionId,
        mint: spec.outputMint,
        usdMicro: spec.inputUsdMicro,
        mode: this.executor.mode,
        signature: ctx.eventSignature,
      });
      return;
    }
    const positionId = 'pos_' + randomUUID();
    repo.insertPosition(this.db, {
      positionId,
      activationId: ctx.activationId,
      candidateId: ctx.candidateId,
      mint: spec.outputMint,
      mintSymbol: null,
      status: 'open',
      entryIntentId: spec.intentId,
      inputMint: spec.inputMint,
      inputUsdMicro: spec.inputUsdMicro,
      copiedTokenBase: outcome.outputAmountBase,
      remainingTokenBase: outcome.outputAmountBase,
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: outcome.feeUsdMicro,
      openedAt: new Date().toISOString(),
      closedAt: null,
      closeReason: null,
    });
    const intent = repo.getIntent(this.db, spec.intentId);
    if (intent) repo.updateIntent(this.db, spec.intentId, { positionId });
    repo.audit(this.db, 'trade', 'copied entry filled', {
      positionId,
      mint: spec.outputMint,
      usdMicro: spec.inputUsdMicro,
      mode: this.executor.mode,
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
  ): Promise<ExecOutcome | 'no-position'> {
    const position = repo.getPosition(this.db, positionId);
    if (!position) return 'no-position';

    // Sell what the wallet actually holds, never more. Recorded amounts come
    // from quoted outputs at entry and can exceed the delivered balance after
    // slippage; asking Jupiter for more fails with InsufficientFunds (6024).
    const remainingRecorded = BigInt(position.remainingTokenBase);
    const onChain = (await this.executor.availableBalance?.(position.mint).catch(() => null)) ?? null;
    if (onChain !== null && exitBase > onChain) {
      repo.audit(this.db, 'trade', 'exit clamped to on-chain balance', {
        positionId,
        requestedBase: exitBase.toString(),
        onChainBase: onChain.toString(),
      });
      exitBase = onChain;
    }
    // The chain is the truth for what remains after the sale.
    if (onChain !== null) remainingAfter = onChain > exitBase ? onChain - exitBase : 0n;
    else if (remainingRecorded >= exitBase) remainingAfter = remainingRecorded - exitBase;

    // Output notional estimation for the exit (token -> funding mint).
    const inputUsdEstimate = await this.estimateUsdMicroForTokens(position.mint, exitBase).catch(() => 0n);
    const intentId = 'intent_' + randomUUID();

    // Nothing on chain to sell: record it and fail closed. The position stays
    // open (never silently "closed" without evidence); the caller's retry and
    // handoff guards surface it to the operator.
    if (exitBase <= 0n) {
      const detail = 'on-chain balance is 0 for this mint — nothing to sell';
      repo.insertIntent(this.db, {
        intentId,
        kind: full ? 'fire_close' : 'exit',
        mode: this.executor.mode,
        activationId: position.activationId,
        candidateId: position.candidateId,
        positionId,
        mint: position.mint,
        inputMint: position.mint,
        inputAmountBase: '0',
        inputUsdMicro: '0',
        state: 'failed',
        reason: detail,
        idempotencyKey: `exit:${positionId}:0:${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      repo.audit(this.db, 'trade', `exit skipped — ${detail}`, { positionId, mint: position.mint });
      return { kind: 'failed', error: detail };
    }

    const spec: IntentSpec = {
      intentId,
      kind: full
        ? closeReason === 'leader_exit' || closeReason === 'time_exit'
          ? 'exit'
          : 'fire_close'
        : 'exit',
      inputMint: position.mint,
      outputMint: position.inputMint,
      inputAmountBase: exitBase.toString(),
      inputDecimals: 6, // best-effort; priced via provider anyway
      outputDecimals: 6,
      inputUsdMicro: inputUsdEstimate.toString(),
      slippageBpsCap: this.risk.MAX_SLIPPAGE_BPS,
      userPublicKey: this.walletPublicKey,
    };
    repo.insertIntent(this.db, {
      intentId,
      kind: spec.kind,
      mode: this.executor.mode,
      activationId: position.activationId,
      candidateId: position.candidateId,
      positionId,
      mint: position.mint,
      inputMint: position.mint,
      inputAmountBase: exitBase.toString(),
      inputUsdMicro: inputUsdEstimate.toString(),
      state: 'pending_quote',
      idempotencyKey: `exit:${positionId}:${exitBase}:${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Live mode with the paper executor mounted means the wallet is locked
    // (armed flag set but the key is not in memory). Simulating the sale here
    // would settle the lot and mark the position closed while the tokens are
    // still in the wallet — the dashboard would show an exit that never
    // happened. Refuse, and surface it for reconciliation instead.
    if (this.liveMode && this.executor.mode !== 'live') {
      const detail = 'wallet locked: live executor not mounted — exit was NOT sent, position left open';
      repo.updateIntent(this.db, intentId, { state: 'requires_reconciliation', reason: detail });
      repo.insertReconciliationCase(this.db, {
        kind: 'wallet_locked',
        intentId,
        positionId,
        signature: null,
        status: 'open',
        detail,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      repo.updatePosition(this.db, positionId, { status: 'requires_reconciliation' });
      repo.audit(this.db, 'monitor', `exit blocked — ${detail}`, {
        positionId,
        mint: position.mint,
      });
      void this.notifier
        .notify(
          `⚠️ ZCode Bot: exit blocked for ${position.mint} — wallet locked, position left OPEN. Re-arm, then close it manually.`,
        )
        .catch(() => {});
      return { kind: 'unknown', detail };
    }

    // Fee headroom: a wallet this low on SOL cannot reliably pay swap fees and
    // account rent, so the swap would fail at preflight. Fail closed with an
    // explicit reason instead of producing a misleading reconciliation case.
    const solLamports = (await this.executor.availableSolLamports?.().catch(() => null)) ?? null;
    if (this.executor.mode === 'live' && solLamports !== null) {
      if (solLamports < MIN_SOL_FOR_FEES_LAMPORTS) {
        const detail = `insufficient SOL for fees: ${solLamports} lamports (need ${MIN_SOL_FOR_FEES_LAMPORTS}) — exit NOT sent`;
        repo.updateIntent(this.db, intentId, { state: 'failed', reason: detail });
        repo.audit(this.db, 'trade', `exit blocked — ${detail}`, { positionId });
        void this.notifier
          .notify(
            `⚠️ ZCode Bot: wallet SOL is ${(solLamports / 1e9).toFixed(4)} — too low to pay fees. Top up before exits will work.`,
          )
          .catch(() => {});
        return { kind: 'failed', error: detail };
      }
      if (solLamports < SOL_LOW_WATERMARK_LAMPORTS) this.alertLowSol(solLamports);
    }

    // Exits are risk-reducing: run them even under pause; skip quote gates for
    // mirrored exits (leader already sold; our job is to mirror, fast).
    let outcome: ExecOutcome;
    try {
      const quote = await this.executor.quote(spec).catch(() => ({
        slippageBps: 0,
        priceImpactBps: 0,
        minOutputBase: '0',
        source: 'assumed' as const,
      }));
      outcome = await this.executor.execute(spec, quote);
    } catch (e) {
      // execute() contains its own send/confirm classification, so anything
      // escaping it happened before a signature existed: retryable, not unknown.
      outcome = { kind: 'failed', error: `executor error before submission: ${(e as Error).message}` };
    }

    if (
      outcome.kind === 'unknown' ||
      (outcome.kind !== 'filled' && outcome.kind !== 'skipped' && outcome.kind !== 'failed')
    ) {
      repo.updateIntent(this.db, intentId, {
        state: 'requires_reconciliation',
        reason: outcome.kind === 'unknown' ? outcome.detail : 'unexpected',
      });
      repo.insertReconciliationCase(this.db, {
        kind: 'unknown_execution',
        intentId,
        positionId,
        signature: null,
        status: 'open',
        detail: outcome.kind === 'unknown' ? outcome.detail : 'unexpected exit outcome',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
      repo.updatePosition(this.db, positionId, { status: 'requires_reconciliation' });
      return outcome;
    }
    if (outcome.kind === 'failed') {
      repo.updateIntent(this.db, intentId, { state: 'failed', reason: outcome.error });
      return outcome;
    }
    if (outcome.kind === 'skipped') {
      repo.updateIntent(this.db, intentId, { state: 'skipped', reason: outcome.reason });
      return outcome;
    }

    // Filled exit: settle the lot.
    const ctx = {
      activationId: position.activationId,
      candidateId: position.candidateId,
      eventSignature: leaderSignature,
    };
    repo.updateIntent(this.db, intentId, { state: 'confirmed', txSignature: outcome.signature });
    repo.insertFill(this.db, {
      fillId: 'fill_' + randomUUID(),
      intentId,
      positionId,
      mode: this.executor.mode,
      txSignature: outcome.signature,
      inputAmountBase: outcome.inputAmountBase,
      outputAmountBase: outcome.outputAmountBase,
      priceUsdMicro: null,
      feeEstimateUsdMicro: outcome.feeUsdMicro,
      balanceEvidenceJson: JSON.stringify(outcome.evidence),
      commitment: outcome.commitment,
      confirmedAt: new Date().toISOString(),
    });
    await this.settleExitFromFill(spec, ctx, outcome, {
      positionId,
      exitBase,
      remainingAfter,
      full,
      closeReason,
    });
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
    // A full close must charge every remaining cent of cost basis. An exit is
    // clamped to the wallet's real balance, which can be below the recorded
    // quantity (recorded sizes include quoted-but-undelivered slippage); a
    // proportional share would leave that basis on the books as phantom equity
    // for a position that no longer exists.
    const priorLots = repo.listPnlLots(this.db, 10000).filter((l) => l.positionId === exit.positionId);
    const bookedCost = priorLots.reduce((sum, l) => sum + BigInt(l.costBasisUsdMicro), 0n);
    const proportionalCost = (BigInt(position.inputUsdMicro) * closedBase) / copiedTotal;
    const fullyClosed = exit.remainingAfter <= 0n;
    const remainingCost = BigInt(position.inputUsdMicro) - bookedCost;
    const costBasis = fullyClosed && remainingCost > proportionalCost ? remainingCost : proportionalCost;
    // Proceeds in USD micro from the funding mint received.
    let proceedsUsdMicro: bigint;
    if (position.inputMint === USDC_MINT || position.inputMint === USDT_MINT) {
      proceedsUsdMicro = BigInt(outcome.outputAmountBase);
    } else {
      const price = await this.prices.priceOf(position.inputMint, 9).catch(() => null);
      proceedsUsdMicro = price
        ? (BigInt(outcome.outputAmountBase) * price.priceUsdMicro) / 10n ** 9n
        : BigInt(spec.inputUsdMicro);
    }
    const fees = BigInt(outcome.feeUsdMicro) + (BigInt(position.feesUsdMicro) * closedBase) / copiedTotal;
    const pnl = proceedsUsdMicro - costBasis - fees;

    repo.insertPnlLot(this.db, {
      positionId: exit.positionId,
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
    repo.updatePosition(this.db, exit.positionId, {
      remainingTokenBase: newRemaining.toString(),
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

    await this.notifier.notify(
      `${result.unitResult.toUpperCase()} close ${exit.full ? '' : '(partial) '}${(Number(pnl) / 1e6).toFixed(2)} USD — streak ${result.streak}/${streakCfg.fireAfter}`,
    );

    if (result.fired) {
      this.callbacks.onFired(ctx.activationId, ctx.candidateId, 'two consecutive losing units');
    }
  }

  private async estimateUsdMicroForTokens(mint: string, base: bigint): Promise<bigint> {
    if (mint === USDC_MINT || mint === USDT_MINT) return base;
    const decimals = 6; // sane default for memecoins; priced per whole token
    const price = await this.prices.priceOf(mint, decimals);
    return (base * price.priceUsdMicro) / 10n ** BigInt(decimals);
  }
}
