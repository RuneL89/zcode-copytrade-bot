import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SENDER_TIP_ACCOUNTS, SENDER_TIP_LAMPORTS } from './sendPath.js';

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
}

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

/**
 * Assemble a legacy transaction from a Swap v2 `/build` body. Lookup-table
 * transactions are not rewritten here: callers that already have
 * `swapTransaction` use that bytes instead. A body with no instructions throws.
 */
export function assembleJupiterBuild(body: JupiterBuildBody, blockhash: string, payer: string): string {
  if (body.swapTransaction && body.swapTransaction.length > 0) return body.swapTransaction;
  const raw = [
    ...(body.computeBudgetInstructions ?? []),
    ...(body.setupInstructions ?? []),
    ...(body.swapInstruction ? [body.swapInstruction] : []),
    ...(body.cleanupInstruction ? [body.cleanupInstruction] : []),
    ...(body.otherInstructions ?? []),
  ];
  if (raw.length === 0) throw new Error('jupiter /build returned no transaction and no instructions');
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: raw.map(toInstruction),
  }).compileToLegacyMessage();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

/** Append the SWQOS tip. Returns null when the transaction is not a legacy message we can extend. */
export function withSenderTip(serializedBase64: string, payer: string, blockhash: string): string | null {
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(serializedBase64, 'base64'));
    if (tx.message.version !== 'legacy') return null;
    const tip = SENDER_TIP_ACCOUNTS[0]!;
    const message = TransactionMessage.decompile(tx.message);
    message.instructions.push(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(payer),
        toPubkey: new PublicKey(tip),
        lamports: SENDER_TIP_LAMPORTS,
      }),
    );
    message.recentBlockhash = blockhash;
    const next = new VersionedTransaction(message.compileToLegacyMessage());
    return Buffer.from(next.serialize()).toString('base64');
  } catch {
    return null;
  }
}
