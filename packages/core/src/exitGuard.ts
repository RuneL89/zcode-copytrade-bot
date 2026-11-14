export type TradingMode = 'paper' | 'live';

/**
 * An exit may run only when the executor's mode matches the position's mode.
 * A paper executor against a live position is a refusal: the position stays
 * open and is not paper-filled.
 */
export function guardExitMode(positionMode: TradingMode, executorMode: TradingMode): 'proceed' | 'refuse' {
  return positionMode === executorMode ? 'proceed' : 'refuse';
}
