/**
 * Helius Sender / SWQOS constants shared by the live executor, the send
 * ladder and the fee ledger. The tip is a plain System transfer, so the fee
 * ledger must know these destinations to attribute it.
 */
export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
] as const;

/** Published SWQOS minimum, lamports. */
export const SENDER_TIP_LAMPORTS = 5_000;
