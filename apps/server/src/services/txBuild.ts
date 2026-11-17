import { randomInt } from 'node:crypto';
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SENDER_TIP_ACCOUNTS, SENDER_TIP_LAMPORTS } from './sendPath.js';

/**
 * Jupiter Swap API v2 `/build` transaction assembly and validation.
 *
 * The live path accepts a transaction only when it is structurally a single-
 * signer swap for our wallet: a known Jupiter program instruction, the wallet
 * as the only required signer (and fee payer), a fresh blockhash, a bounded
 * compute-unit limit, and a size that still fits after the Sender tip. A
 * partial/instruction-less body is rejected instead of signed.
 */

export interface JupiterInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterInstruction {
  programId: string;
  accounts?: JupiterInstructionAccount[];
  data?: string;
}

export interface JupiterBuildBody {
  swapTransaction?: string;
  computeBudgetInstructions?: JupiterInstruction[];
  setupInstructions?: JupiterInstruction[];
  swapInstruction?: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null;
  otherInstructions?: JupiterInstruction[];
  /** Swap v2 can return lookup-table addresses for a v0 message. */
  addressLookupTableAddresses?: string[];
}

export interface AssembleOptions {
  blockhash: string;
  lastValidBlockHeight: number;
  payer: string;
  /** Resolved lookup tables for a v0 build; required when the body uses them. */
  altAccounts?: AddressLookupTableAccount[];
  /** Append the Sender/SWQOS tip when true (default true). */
  addTip?: boolean;
}

export interface BuiltTransaction {
  base64: string;
  kind: 'legacy' | 'v0';
  blockhash: string;
  lastValidBlockHeight: number;
  swapProgramId: string;
  instructionCount: number;
  tipLamports: number;
  tipAccount: string | null;
}

export const MAX_TRANSACTION_BYTES = 1232;
export const MIN_COMPUTE_UNITS = 50_000;
export const MAX_COMPUTE_UNITS = 1_400_000;
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SET_COMPUTE_UNIT_LIMIT = 2;

/**
 * Known Jupiter aggregator programs. A new program ID must fail closed until
 * this list is updated: an unknown program can move funds in ways the swap
 * validator cannot recognize.
 */
export const JUPITER_PROGRAM_IDS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // v6
  'JUP5pEAZeHdHrLxh5UCwAbpjGwYKKoquCpda2hfP42u', // v5
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // v4
  'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph', // v3
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFY9RmckD2', // v2
] as const;
const JUPITER_PROGRAMS = new Set<string>(JUPITER_PROGRAM_IDS);

function toInstruction(raw: JupiterInstruction): TransactionInstruction {
  if (!raw.programId) throw new Error('jupiter instruction is missing programId');
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: (raw.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(raw.data ?? '', 'base64'),
  });
}

function swapProgramOf(instructions: TransactionInstruction[]): string | null {
  for (const ix of instructions) {
    const id = ix.programId.toBase58();
    if (JUPITER_PROGRAMS.has(id)) return id;
  }
  return null;
}

function computeUnitLimitOf(instructions: TransactionInstruction[]): number | null {
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM) continue;
    const data = Buffer.from(ix.data);
    if (data.length >= 5 && data[0] === SET_COMPUTE_UNIT_LIMIT) return data.readUInt32LE(1);
  }
  return null;
}

function requireComputeUnitLimit(instructions: TransactionInstruction[]): number {
  const limit = computeUnitLimitOf(instructions);
  if (limit === null) {
    throw new Error('jupiter /build has no SetComputeUnitLimit instruction');
  }
  if (limit < MIN_COMPUTE_UNITS || limit > MAX_COMPUTE_UNITS) {
    throw new Error(
      `jupiter /build compute-unit limit ${limit} is outside ${MIN_COMPUTE_UNITS}..${MAX_COMPUTE_UNITS}`,
    );
  }
  return limit;
}

function tipTransferOf(instructions: TransactionInstruction[]): { account: string; lamports: number } | null {
  const tips = new Set<string>(SENDER_TIP_ACCOUNTS);
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== SystemProgram.programId.toBase58()) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;
    const to = ix.keys[1]?.pubkey.toBase58();
    if (to && tips.has(to)) return { account: to, lamports: Number(data.readBigUInt64LE(4)) };
  }
  return null;
}

function appendTip(
  instructions: TransactionInstruction[],
  payer: string,
): { instructions: TransactionInstruction[]; account: string | null; lamports: number } {
  const existing = tipTransferOf(instructions);
  if (existing) return { instructions, account: existing.account, lamports: existing.lamports };
  const account = SENDER_TIP_ACCOUNTS[randomInt(0, SENDER_TIP_ACCOUNTS.length)]!;
  return {
    instructions: [
      ...instructions,
      SystemProgram.transfer({
        fromPubkey: new PublicKey(payer),
        toPubkey: new PublicKey(account),
        lamports: SENDER_TIP_LAMPORTS,
      }),
    ],
    account,
    lamports: SENDER_TIP_LAMPORTS,
  };
}

function messageKind(tx: VersionedTransaction): 'legacy' | 'v0' {
  return tx.message.version === 'legacy' ? 'legacy' : 'v0';
}

function validateSigners(tx: VersionedTransaction, payer: string): void {
  const required = tx.message.header.numRequiredSignatures;
  if (required !== 1) {
    throw new Error(`swap transaction requires ${required} signers; expected exactly the wallet`);
  }
  const first = tx.message.staticAccountKeys[0];
  if (!first) throw new Error('swap transaction has no fee payer');
  if (first.toBase58() !== payer) {
    throw new Error(`swap transaction fee payer ${first.toBase58()} is not the configured wallet`);
  }
}

function compiledBytes(
  message: TransactionMessage,
  kind: 'legacy' | 'v0',
  alts: AddressLookupTableAccount[],
): Uint8Array {
  const compiled = kind === 'v0' ? message.compileToV0Message(alts) : message.compileToLegacyMessage();
  const bytes = new VersionedTransaction(compiled).serialize();
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `swap transaction is ${bytes.length} bytes; the ${MAX_TRANSACTION_BYTES}-byte limit is exceeded`,
    );
  }
  return bytes;
}

/** Lookup-table addresses a build body would need resolved before assembly. */
export function lookupTableAddresses(body: JupiterBuildBody): string[] {
  if (!body.swapTransaction) return body.addressLookupTableAddresses ?? [];
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
    if (tx.message.version === 'legacy') return [];
    return tx.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58());
  } catch (e) {
    throw new Error(`jupiter swapTransaction is not a valid transaction: ${(e as Error).message}`);
  }
}

/**
 * Assemble and validate a Jupiter `/build` body. Returns the unsigned base64
 * message plus the exact blockhash/height it carries. Throws on any partial,
 * unexpected-signer, wrong-payer, missing-swap or oversized build.
 */
export function assembleJupiterBuild(body: JupiterBuildBody, opts: AssembleOptions): BuiltTransaction {
  const addTip = opts.addTip !== false;
  const payer = opts.payer;

  if (body.swapTransaction && body.swapTransaction.length > 0) {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
    } catch (e) {
      throw new Error(`jupiter swapTransaction is not a valid transaction: ${(e as Error).message}`);
    }
    const kind = messageKind(tx);
    validateSigners(tx, payer);
    if (kind === 'v0' && tx.message.addressTableLookups.length > 0 && !opts.altAccounts?.length) {
      throw new Error('jupiter swapTransaction uses lookup tables but none were resolved');
    }
    let message: TransactionMessage;
    try {
      message = TransactionMessage.decompile(tx.message, {
        addressLookupTableAccounts: opts.altAccounts ?? [],
      });
    } catch (e) {
      throw new Error(`jupiter swapTransaction could not be decompiled: ${(e as Error).message}`);
    }
    const swapProgramId = swapProgramOf(message.instructions);
    if (!swapProgramId) {
      throw new Error('jupiter swapTransaction contains no known Jupiter swap instruction');
    }
    requireComputeUnitLimit(message.instructions);
    message.recentBlockhash = opts.blockhash;
    const tipped = addTip
      ? appendTip(message.instructions, payer)
      : { instructions: message.instructions, account: null, lamports: 0 };
    const compiled = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: opts.blockhash,
      instructions: tipped.instructions,
    });
    const bytes = compiledBytes(compiled, kind, opts.altAccounts ?? []);
    return {
      base64: Buffer.from(bytes).toString('base64'),
      kind,
      blockhash: opts.blockhash,
      lastValidBlockHeight: opts.lastValidBlockHeight,
      swapProgramId,
      instructionCount: tipped.instructions.length,
      tipLamports: tipped.lamports,
      tipAccount: tipped.account,
    };
  }

  if (!body.swapInstruction) {
    throw new Error('jupiter /build returned no swapInstruction and no swapTransaction');
  }
  const swapProgramId = body.swapInstruction.programId;
  if (!JUPITER_PROGRAMS.has(swapProgramId)) {
    throw new Error(`jupiter swap instruction program ${swapProgramId} is not a known aggregator`);
  }
  const raw = [
    ...(body.computeBudgetInstructions ?? []),
    ...(body.setupInstructions ?? []),
    ...(body.swapInstruction ? [body.swapInstruction] : []),
    ...(body.cleanupInstruction ? [body.cleanupInstruction] : []),
    ...(body.otherInstructions ?? []),
  ].map(toInstruction);
  requireComputeUnitLimit(raw);
  const tipped = addTip ? appendTip(raw, payer) : { instructions: raw, account: null, lamports: 0 };
  const alts = opts.altAccounts ?? [];
  const hasLookups = (body.addressLookupTableAddresses?.length ?? 0) > 0;
  if (hasLookups && alts.length === 0) {
    throw new Error('jupiter /build requested lookup tables but none were resolved');
  }
  const kind: 'legacy' | 'v0' = hasLookups ? 'v0' : 'legacy';
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: opts.blockhash,
    instructions: tipped.instructions,
  });
  const bytes = compiledBytes(message, kind, alts);
  return {
    base64: Buffer.from(bytes).toString('base64'),
    kind,
    blockhash: opts.blockhash,
    lastValidBlockHeight: opts.lastValidBlockHeight,
    swapProgramId,
    instructionCount: tipped.instructions.length,
    tipLamports: tipped.lamports,
    tipAccount: tipped.account,
  };
}

/**
 * Legacy compatibility helper used by tests: append the Sender tip to a legacy
 * message and return the base64 (null for a v0 message, which needs resolved
 * lookup tables). Production execution uses `assembleJupiterBuild`.
 */
export function withSenderTip(serializedBase64: string, payer: string, blockhash: string): string | null {
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(serializedBase64, 'base64'));
    if (tx.message.version !== 'legacy') return null;
    const message = TransactionMessage.decompile(tx.message);
    message.recentBlockhash = blockhash;
    const tipped = appendTip(message.instructions, payer);
    const next = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: blockhash,
      instructions: tipped.instructions,
    });
    return Buffer.from(next.compileToLegacyMessage().serialize()).toString('base64');
  } catch {
    return null;
  }
}
