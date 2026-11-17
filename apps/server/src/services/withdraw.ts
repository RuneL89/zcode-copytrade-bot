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
import { USDC_MINT } from './engine.js';
import { loadWalletSecret, walletExists, walletPublicKey } from '../wallet.js';

/**
 * Withdrawals from the bot's Solana wallet.
 *
 * Money may only leave from the FREE bankroll: funds attributed to open
 * positions (their entry cost incl. fees) are never withdrawable, and a SOL fee
 * reserve is kept back so the bot can still pay for transactions. The private
 * key is unlocked in memory for the single send and never stored, logged, or
 * returned to any client.
 *
 * The broadcast is a typed, injectable interface so tests never sign or submit
 * a real transaction.
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

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    try {
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confirmation.value.err) {
        return {
          kind: 'failed',
          error: `transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        };
      }
      return { kind: 'filled', signature };
    } catch (e) {
      // Submitted but unconfirmed: report the signature, never blind-retry.
      return {
        kind: 'unknown',
        signature,
        detail: `submitted ${signature}; confirmation unknown: ${(e as Error).message}`,
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
}

export type WithdrawResult =
  | {
      ok: true;
      signature: string;
      asset: WithdrawAsset;
      amountBase: string;
      destination: string;
      unconfirmed: boolean;
    }
  | { ok: false; code: string; error: string };

export class WithdrawalService {
  constructor(
    private db: AppDatabase,
    private config: AppConfig,
    private control: ControlService,
    private helius: HeliusProvider,
    private equityStartUsdMicro: bigint,
    private broadcaster: Broadcaster,
  ) {}

  /** Free cash = capital − deployed (open positions' entry cost incl. fees). */
  cashUsdMicro(): bigint {
    const open = repo.openPositions(this.db);
    return bankrollHeadroom({
      equityStartUsdMicro: this.equityStartUsdMicro,
      openEntriesUsdMicro: open.reduce((acc, p) => acc + BigInt(p.inputUsdMicro), 0n),
      openFeesUsdMicro: open.reduce((acc, p) => acc + BigInt(p.feesUsdMicro), 0n),
      realizedNetUsdMicro: repo.realizedPnlSince(this.db, '1970-01-01T00:00:00.000Z'),
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
    if (this.config.mode === 'demo') {
      return { ok: false, code: 'MODE_UNSUPPORTED', error: 'demo mode has no real wallet' };
    }
    if (!walletExists(this.config.env.DATA_DIR, this.config.env.WALLET_FILE)) {
      return { ok: false, code: 'NO_WALLET', error: 'no wallet; create one in OPS first' };
    }
    const asset: WithdrawAsset = request.asset === 'SOL' ? 'SOL' : 'USDC';
    const decimals = asset === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
    const parsed = parseAmountToBase(request.amount, decimals);
    if (!parsed.ok) return { ok: false, code: parsed.code, error: parsed.detail };

    const sourcePublicKey = walletPublicKey(this.config.env.DATA_DIR, this.config.env.WALLET_FILE);
    if (!sourcePublicKey) {
      return { ok: false, code: 'NO_WALLET', error: 'wallet file unreadable' };
    }

    // Destination validation uses the same 32-byte base58 check web3.js enforces.
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
      return { ok: false, code: 'WALLET_UNLOCK_FAILED', error: (e as Error).message };
    }

    // Re-read balances immediately before signing: the cap must reflect the
    // chain right now, not a cached dashboard value.
    const solLamports = await this.helius.solBalanceLamports(sourcePublicKey);
    const usdcBase = await this.helius.tokenBalanceBase(USDC_MINT, sourcePublicKey);
    if (solLamports === null || usdcBase === null) {
      return {
        ok: false,
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
    if (!plan.ok) return { ok: false, code: plan.code ?? 'REJECTED', error: plan.detail ?? 'rejected' };

    // Block new entries for the duration: a monitor tick must not spend the
    // cash that is being withdrawn between the check above and the broadcast.
    this.control.withdrawInFlight = true;
    let outcome: TransferOutcome;
    try {
      outcome = await this.broadcaster({
        asset,
        destination: request.destination.trim(),
        amountBase: parsed.base,
        secretKey,
        sourcePublicKey,
      });
    } catch (e) {
      outcome = { kind: 'failed', error: (e as Error).message };
    } finally {
      this.control.withdrawInFlight = false;
    }

    const auditBase = {
      asset,
      amountBase: parsed.base.toString(),
      destination: request.destination.trim(),
    };
    if (outcome.kind === 'filled') {
      repo.audit(this.db, 'wallet', 'withdrawal sent', { ...auditBase, signature: outcome.signature });
      return {
        ok: true,
        signature: outcome.signature,
        asset,
        amountBase: parsed.base.toString(),
        destination: request.destination.trim(),
        unconfirmed: false,
      };
    }
    if (outcome.kind === 'unknown') {
      repo.audit(this.db, 'wallet', 'withdrawal submitted — confirmation unknown', {
        ...auditBase,
        signature: outcome.signature,
        detail: outcome.detail,
      });
      return {
        ok: true,
        signature: outcome.signature,
        asset,
        amountBase: parsed.base.toString(),
        destination: request.destination.trim(),
        unconfirmed: true,
      };
    }
    repo.audit(this.db, 'wallet', 'withdrawal failed', { ...auditBase, error: outcome.error });
    return { ok: false, code: 'TRANSFER_FAILED', error: outcome.error };
  }
}
