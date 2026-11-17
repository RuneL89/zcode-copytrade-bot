/**
 * Order intent lifecycle. Every transition is explicit; the guarded map makes
 * "blindly retry an ambiguous signed/submitted order" structurally impossible:
 * there is NO transition from 'signed' or 'submitted' back to 'pending_quote'.
 */

export type OrderIntentState =
  | 'pending_quote'
  | 'quoted'
  | 'quote_rejected'
  | 'pending_sign'
  | 'signed'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'requires_reconciliation';

const TRANSITIONS: Record<OrderIntentState, OrderIntentState[]> = {
  pending_quote: ['quoted', 'quote_rejected', 'failed', 'skipped', 'cancelled'],
  // `confirmed` from `quoted` is the PAPER simulation path only. A live
  // executor must walk pending_sign -> signed -> submitted, because the
  // signed/submitted rows are what make an ambiguous send reconcilable.
  quoted: ['pending_sign', 'quote_rejected', 'skipped', 'cancelled', 'confirmed', 'failed'],
  quote_rejected: [],
  pending_sign: ['signed', 'failed', 'cancelled', 'requires_reconciliation'],
  signed: ['submitted', 'requires_reconciliation', 'failed'],
  submitted: ['confirmed', 'requires_reconciliation', 'failed'],
  confirmed: [],
  failed: [],
  skipped: [],
  cancelled: [],
  requires_reconciliation: ['confirmed', 'failed'], // only with evidence from reconciliation
};

export function canTransitionOrder(from: OrderIntentState, to: OrderIntentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionOrder(from: OrderIntentState, to: OrderIntentState): OrderIntentState {
  if (!canTransitionOrder(from, to)) {
    throw new Error(`Illegal order intent transition ${from} -> ${to}`);
  }
  return to;
}

/** An unknown outcome after signing/submission routes here, never to retry. */
export function unknownOutcomeTarget(): OrderIntentState {
  return 'requires_reconciliation';
}
