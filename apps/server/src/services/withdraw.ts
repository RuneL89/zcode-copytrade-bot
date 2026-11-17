import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppConfig } from '@zcode-bot/config';
import type { HeliusProvider } from '@zcode-bot/providers';
import {
  bankrollHeadroom,
  parseAmountToBase,
  planWithdrawal,
  withdrawableBase,
  SOL_DECIMALS,
  SOL_FEE_RESERVE_LAMPORTS,
  USDC_DECIMALS,
  type WithdrawAsset,
} from '@zcode-bot/core';
import type { ControlService } from './control.js';
import type { TradingLocks } from './locks.js';
import type { ReconciliationReader } from './engine.js';
import { USDC_MINT } from './engine.js';
import { loadWalletSecret, walletExists, walletPublicKey } from '../wallet.js';

/**
 * Withdrawals from the bot's Solana wallet.
 *
 * Real money may only leave in live mode with LIVE_TRADING on. Every attempt
 * is written to `withdrawals` before signing, carries a client idempotency
 * key, and is serialized so two requests cannot both spend the same cash. An
 * ambiguous broadcast becomes `unknown` and blocks further withdrawals until
 * chain reconciliation resolves it.
 *
 * The private key is unlocked in memory for the single send and never stored,
 * logged, or returned to any client.
 */

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL_TRANSFER_CHECKED = 12;
const SPL_CREATE_IDEMPOTENT = 1;

export interface TransferRequest {
  asset: WithdrawAsset;
  destination: string;
  amountBase: bigint;
  secretKey: Uint8Array;
  sourcePublicKey: string;
  /** Called after signing and BEFORE the network send; may throw to abort. */
  onSigned?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void;
}

export type TransferOutcome =
  | { kind: 'filled'; signature: string }
  | { kind: 'failed'; error: string }
  | { kind: 'unknown'; signature: string; detail: string };

/** Injected in tests; the production implementation signs with web3.js. */
export type Broadcaster = (request: TransferRequest) => Promise<TransferOutcome>;

/** SPL `TransferChecked` instruction data: tag 12 | amount u64 LE | decimals u8. */
export function splTransferCheckedData(amountBase: bigint, decimals: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = SPL_TRANSFER_CHECKED;
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amountBase, true);
  data[9] = decimals;
  return data;
}

/** SPL associated-token `CreateIdempotent` instruction data: tag 1. */
export function splCreateIdempotentData(): Uint8Array {
  return new Uint8Array([SPL_CREATE_IDEMPOTENT]);
}

export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

/**
 * Production broadcaster. web3.js is imported lazily so module load (and the
 * whole test suite) never pulls in the signing stack.
 */
export function createSolanaBroadcaster(rpcUrl: () => string): Broadcaster {
  return async (request) => {
    const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } =
      await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    const connection = new Connection(rpcUrl(), 'confirmed');
    const from = Keypair.fromSecretKey(request.secretKey);
    const to = new PublicKey(request.destination);

    const tx = new Transaction();
    if (request.asset === 'SOL') {
      const lamports = Number(request.amountBase);
      if (!Number.isSafeInteger(lamports) || lamports <= 0) {
        return { kind: 'failed', error: 'SOL amount out of range' };
      }
      tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
    } else {
      const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
      const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
      const mint = new PublicKey(USDC_MINT);
      const ataFor = (owner: InstanceType<typeof PublicKey>) =>
        PublicKey.findProgramAddressSync(
          [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
          ataProgram,
        )[0];
      const sourceAta = ataFor(from.publicKey);
      const destinationAta = ataFor(to);

      const destinationInfo = await connection.getAccountInfo(destinationAta);
      if (!destinationInfo) {
        // Recipient has no USDC account yet: create it (idempotent) first.
        tx.add(
          new TransactionInstruction({
            programId: ataProgram,
            keys: [
              { pubkey: from.publicKey, isSigner: true, isWritable: true },
              { pubkey: destinationAta, isSigner: false, isWritable: true },
              { pubkey: to, isSigner: false, isWritable: false },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: tokenProgram, isSigner: false, isWritable: false },
            ],
            data: Buffer.from(splCreateIdempotentData()),
          }),
        );
      }
      tx.add(
        new TransactionInstruction({
          programId: tokenProgram,
          keys: [
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: destinationAta, isSigner: false, isWritable: true },
            { pubkey: from.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from(splTransferCheckedData(request.amountBase, USDC_DECIMALS)),
        }),
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = from.publicKey;
    tx.sign(from);
    const localSignature = bs58.encode(tx.signatures[0]!.signature!);
    // Durable signed evidence is written before the bytes leave the process.
    request.onSigned?.({ signature: localSignature, blockhash, lastValidBlockHeight });

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    if (signature !== localSignature) {
      return {
        kind: 'unknown',
        signature: localSignature,
        detail: `RPC returned ${signature} for locally signed ${localSignature}`,
      };
    }
    try {
      const confirmation = await connection.confirmTransaction(
        { signature: localSignature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confirmation.value.err) {
        return {
          kind: 'failed',
          error: `transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        };
      }
      return { kind: 'filled', signature: localSignature };
    } catch (e) {
      // Submitted but unconfirmed: report the signature, never blind-retry.
      return {
        kind: 'unknown',
        signature: localSignature,
        detail: `submitted ${localSignature}; confirmation unknown: ${(e as Error).message}`,
      };
    }
  };
}

export interface WithdrawableInfo {
  hasWallet: boolean;
  publicKey: string | null;
  solLamports: string | null;
  usdcBase: string | null;
  cashUsdMicro: string;
  withdrawableSolBase: string;
  withdrawableUsdcBase: string;
  solReserveLamports: string;
}

export interface WithdrawRequest {
  asset: WithdrawAsset;
  destination: string;
  amount: string;
  walletSecret: string;
  confirm: string;
  /** Client-generated retry key. Omitted means a fresh key is created. */
  idempotencyKey?: string;
}

export type WithdrawResult =
  | {
      ok: true;
      signature: string;
      asset: WithdrawAsset;
      amountBase: string;
      destination: string;
      unconfirmed: boolean;
      idempotencyKey: string;
    }
  | { ok: false; code: string; error: string; idempotencyKey?: string };

export class WithdrawalService {
  constructor(
    private db: AppDatabase,
    private config: AppConfig,
    private control: ControlService,
    private helius: HeliusProvider,
    private equityStartUsdMicro: bigint,
    private broadcaster: Broadcaster,
    private locks: TradingLocks,
  ) {}

  private get mode(): 'paper' | 'live' {
    return this.config.mode === 'live' ? 'live' : 'paper';
  }

  /**
   * Free cash = capital − deployed. Deployed uses remaining cost basis (so a
   * partial close releases it), pending entry reservations, unresolved entries
   * and pending withdrawals. Realized PnL is mode-scoped; successful USDC
   * withdrawals reduce capital permanently.
   */
  cashUsdMicro(): bigint {
    const positions = repo.exposurePositions(this.db, this.mode);
    const pending = repo.pendingEntryIntents(this.db, this.mode);
    const unresolved = repo.unresolvedEntryIntents(this.db, this.mode);
    const totals = repo.withdrawalTotals(this.db, this.mode);
    const reservedEntryUsdMicro =
      pending.reduce((acc, i) => acc + BigInt(i.reservedUsdMicro), 0n) +
      unresolved.reduce((acc, i) => acc + BigInt(i.inputUsdMicro ?? '0'), 0n);
    return bankrollHeadroom({
      equityStartUsdMicro: this.equityStartUsdMicro,
      openEntriesUsdMicro: positions.reduce((acc, p) => acc + BigInt(p.remainingCostBasisUsdMicro), 0n),
      openFeesUsdMicro: positions.reduce((acc, p) => acc + BigInt(p.remainingFeesUsdMicro), 0n),
      reservedEntryUsdMicro,
      capitalAdjustmentsUsdMicro: -(totals.sentUsdMicro + totals.reservedUsdMicro),
      realizedNetUsdMicro: repo.realizedPnlSince(this.db, '1970-01-01T00:00:00.000Z', this.mode),
      maxDeployedPct: this.config.risk.MAX_DEPLOYED_PCT,
    }).cashUsdMicro;
  }

  async available(): Promise<WithdrawableInfo> {
    const pk = walletPublicKey(this.config.env.DATA_DIR, this.config.env.WALLET_FILE);
    const cash = this.cashUsdMicro();
    if (!pk) {
      return {
        hasWallet: false,
        publicKey: null,
        solLamports: null,
        usdcBase: null,
        cashUsdMicro: cash.toString(),
        withdrawableSolBase: '0',
        withdrawableUsdcBase: '0',
        solReserveLamports: SOL_FEE_RESERVE_LAMPORTS.toString(),
      };
    }
    const solLamports = await this.helius.solBalanceLamports(pk);
    const usdcBase = await this.helius.tokenBalanceBase(USDC_MINT, pk);
    const solBase = solLamports === null ? 0n : BigInt(solLamports);
    const usdc = usdcBase ?? 0n;
    return {
      hasWallet: true,
      publicKey: pk,
      solLamports: solLamports === null ? null : String(solLamports),
      usdcBase: usdcBase === null ? null : usdcBase.toString(),
      cashUsdMicro: cash.toString(),
      withdrawableSolBase: withdrawableBase({
        asset: 'SOL',
        onchainBase: solBase,
        cashUsdMicro: cash,
      }).toString(),
      withdrawableUsdcBase: withdrawableBase({
        asset: 'USDC',
        onchainBase: usdc,
        cashUsdMicro: cash,
      }).toString(),
      solReserveLamports: SOL_FEE_RESERVE_LAMPORTS.toString(),
    };
  }

  async send(request: WithdrawRequest): Promise<WithdrawResult> {
    if (request.confirm !== 'SEND') {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', error: 'withdrawal requires confirm:"SEND"' };
    }
    if (this.config.mode !== 'live' || !this.config.env.LIVE_TRADING) {
      return {
        ok: false,
        code: 'MODE_UNSUPPORTED',
        error: 'real withdrawals require MODE=live and LIVE_TRADING=true',
      };
    }
    const key = (request.idempotencyKey ?? '').trim() || `wd_${randomUUID()}`;
    if (key.length < 8 || key.length > 100) {
      return {
        ok: false,
        code: 'INVALID_IDEMPOTENCY_KEY',
        error: 'idempotencyKey must be 8-100 characters',
      };
    }

    return this.locks.withdraw(async () => {
      const existing = repo.getWithdrawalByIdempotencyKey(this.db, key);
      if (existing) {
        if (existing.status === 'sent') {
          return {
            ok: true as const,
            signature: existing.signature ?? '',
            asset: existing.asset as WithdrawAsset,
            amountBase: existing.amountBase,
            destination: existing.destination,
            unconfirmed: false,
            idempotencyKey: key,
          };
        }
        if (existing.status === 'failed') {
          return {
            ok: false as const,
            code: 'TRANSFER_FAILED',
            error: existing.error ?? 'withdrawal failed',
            idempotencyKey: key,
          };
        }
        return {
          ok: false as const,
          code: 'WITHDRAWAL_PENDING',
          error: `withdrawal ${existing.withdrawalId} is ${existing.status}; resolve it before retrying`,
          idempotencyKey: key,
        };
      }
      if (repo.openWithdrawals(this.db, this.mode).length > 0) {
        return {
          ok: false as const,
          code: 'WITHDRAWAL_PENDING',
          error: 'another withdrawal is awaiting chain resolution',
          idempotencyKey: key,
        };
      }
      if (!walletExists(this.config.env.DATA_DIR, this.config.env.WALLET_FILE)) {
        return { ok: false as const, code: 'NO_WALLET', error: 'no wallet; create one in OPS first' };
      }
      const asset: WithdrawAsset = request.asset === 'SOL' ? 'SOL' : 'USDC';
      const decimals = asset === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
      const parsed = parseAmountToBase(request.amount, decimals);
      if (!parsed.ok) {
        return { ok: false as const, code: parsed.code, error: parsed.detail };
      }

      const sourcePublicKey = walletPublicKey(this.config.env.DATA_DIR, this.config.env.WALLET_FILE);
      if (!sourcePublicKey) {
        return { ok: false as const, code: 'NO_WALLET', error: 'wallet file unreadable' };
      }

      let destinationValid = true;
      try {
        const { PublicKey } = await import('@solana/web3.js');
        new PublicKey(request.destination);
      } catch {
        destinationValid = false;
      }

      let secretKey: Uint8Array;
      try {
        secretKey = loadWalletSecret(
          this.config.env.DATA_DIR,
          request.walletSecret ?? '',
          this.config.env.WALLET_FILE,
        );
      } catch (e) {
        return {
          ok: false as const,
          code: 'WALLET_UNLOCK_FAILED',
          error: (e as Error).message,
        };
      }

      // Re-read balances immediately before signing: the cap must reflect the
      // chain right now, not a cached dashboard value.
      const solLamports = await this.helius.solBalanceLamports(sourcePublicKey);
      const usdcBase = await this.helius.tokenBalanceBase(USDC_MINT, sourcePublicKey);
      if (solLamports === null || usdcBase === null) {
        return {
          ok: false as const,
          code: 'BALANCE_UNAVAILABLE',
          error: 'could not read on-chain balances; try again',
        };
      }
      const cash = this.cashUsdMicro();
      const cap =
        asset === 'SOL'
          ? withdrawableBase({ asset, onchainBase: BigInt(solLamports), cashUsdMicro: cash })
          : withdrawableBase({ asset, onchainBase: usdcBase, cashUsdMicro: cash });

      const plan = planWithdrawal({
        asset,
        amountBase: parsed.base,
        withdrawableBase: cap,
        destinationValid,
        destinationIsSelf: request.destination.trim() === sourcePublicKey,
      });
      if (!plan.ok) {
        return { ok: false as const, code: plan.code ?? 'REJECTED', error: plan.detail ?? 'rejected' };
      }

      const withdrawalId = 'wd_' + randomUUID();
      const nowIso = new Date().toISOString();
      repo.insertWithdrawal(this.db, {
        withdrawalId,
        mode: this.mode,
        asset,
        amountBase: parsed.base.toString(),
        amountUsdMicro: asset === 'USDC' ? parsed.base.toString() : null,
        destination: request.destination.trim(),
        status: 'pending',
        signature: null,
        blockhash: null,
        lastValidBlockHeight: null,
        idempotencyKey: key,
        error: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        resolvedAt: null,
      });

      this.control.withdrawInFlight = true;
      let outcome: TransferOutcome;
      try {
        outcome = await this.broadcaster({
          asset,
          destination: request.destination.trim(),
          amountBase: parsed.base,
          secretKey,
          sourcePublicKey,
          onSigned: (info) => {
            repo.updateWithdrawal(this.db, withdrawalId, {
              status: 'signed',
              signature: info.signature,
              blockhash: info.blockhash,
              lastValidBlockHeight: info.lastValidBlockHeight,
            });
          },
        });
      } catch (e) {
        outcome = { kind: 'failed', error: (e as Error).message };
      } finally {
        this.control.withdrawInFlight = false;
      }

      const auditBase = {
        withdrawalId,
        asset,
        amountBase: parsed.base.toString(),
        destination: request.destination.trim(),
      };
      if (outcome.kind === 'filled') {
        repo.updateWithdrawal(this.db, withdrawalId, {
          status: 'sent',
          signature: outcome.signature,
          resolvedAt: new Date().toISOString(),
        });
        repo.audit(this.db, 'wallet', 'withdrawal sent', {
          ...auditBase,
          signature: outcome.signature,
        });
        return {
          ok: true as const,
          signature: outcome.signature,
          asset,
          amountBase: parsed.base.toString(),
          destination: request.destination.trim(),
          unconfirmed: false,
          idempotencyKey: key,
        };
      }
      if (outcome.kind === 'unknown') {
        repo.updateWithdrawal(this.db, withdrawalId, {
          status: 'unknown',
          signature: outcome.signature,
          error: outcome.detail,
        });
        repo.insertReconciliationCase(this.db, {
          kind: 'unknown_withdrawal',
          mode: this.mode,
          intentId: null,
          positionId: null,
          signature: outcome.signature,
          withdrawalId,
          status: 'open',
          detail: outcome.detail,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
        repo.audit(this.db, 'wallet', 'withdrawal submitted — confirmation unknown', {
          ...auditBase,
          signature: outcome.signature,
          detail: outcome.detail,
        });
        return {
          ok: true as const,
          signature: outcome.signature,
          asset,
          amountBase: parsed.base.toString(),
          destination: request.destination.trim(),
          unconfirmed: true,
          idempotencyKey: key,
        };
      }
      repo.updateWithdrawal(this.db, withdrawalId, {
        status: 'failed',
        error: outcome.error,
        resolvedAt: new Date().toISOString(),
      });
      repo.audit(this.db, 'wallet', 'withdrawal failed', { ...auditBase, error: outcome.error });
      return {
        ok: false as const,
        code: 'TRANSFER_FAILED',
        error: outcome.error,
        idempotencyKey: key,
      };
    });
  }

  /**
   * Resolve pending/unknown withdrawals against chain evidence. A confirmed
   * signature is `sent`; a definitively expired missing signature is `failed`;
   * anything else stays pending.
   */
  async reconcileWithdrawals(
    reader: ReconciliationReader,
  ): Promise<{ reviewed: number; sent: number; failed: number; pending: number }> {
    const out = { reviewed: 0, sent: 0, failed: 0, pending: 0 };
    for (const row of repo.openWithdrawals(this.db, this.mode)) {
      out.reviewed++;
      if (!row.signature) {
        out.pending++;
        continue;
      }
      const status = await reader.signatureStatus(row.signature);
      if (status === null) {
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
        if (status.err) {
          repo.updateWithdrawal(this.db, row.withdrawalId, {
            status: 'failed',
            error: `on-chain failure: ${JSON.stringify(status.err)}`,
            resolvedAt: new Date().toISOString(),
          });
          out.failed++;
        } else {
          repo.updateWithdrawal(this.db, row.withdrawalId, {
            status: 'sent',
            resolvedAt: new Date().toISOString(),
          });
          out.sent++;
        }
        this.resolveWithdrawalCases(row.withdrawalId);
        continue;
      }
      const height = await reader.blockHeight();
      if (row.lastValidBlockHeight !== null && height !== null && height > row.lastValidBlockHeight + 150) {
        repo.updateWithdrawal(this.db, row.withdrawalId, {
          status: 'failed',
          error: 'transaction expired without landing',
          resolvedAt: new Date().toISOString(),
        });
        this.resolveWithdrawalCases(row.withdrawalId);
        out.failed++;
      } else {
        out.pending++;
      }
    }
    return out;
  }

  private resolveWithdrawalCases(withdrawalId: string): void {
    for (const c of repo.openReconciliationCases(this.db, this.mode)) {
      if (c.withdrawalId === withdrawalId) repo.resolveReconciliationCase(this.db, c.id);
    }
  }
}
