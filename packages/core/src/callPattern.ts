/**
 * Static call-pattern check. Timer-owned files may not name
 * `getTransactionsForAddress` or `transactionsSince` (the helper that issues
 * it). Vetting is a separate file and is not passed in.
 */

export interface SourceFile {
  name: string;
  source: string;
}

export interface CallHit {
  file: string;
  line: number;
  text: string;
}

export const TIMER_SOURCE_PATHS = [
  'apps/server/src/services/monitor.ts',
  'apps/server/src/services/watch.ts',
  'apps/server/src/services/rosterStream.ts',
  'apps/server/src/runtime.ts',
] as const;

function stripLineComment(line: string): string {
  const block = line.replace(/\/\*.*?\*\//g, '');
  const slash = block.indexOf('//');
  return slash >= 0 ? block.slice(0, slash) : block;
}

export function findFullHistoryInTimers(files: SourceFile[]): CallHit[] {
  const hits: CallHit[] = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    lines.forEach((line, index) => {
      const code = stripLineComment(line);
      if (code.includes('getTransactionsForAddress') || code.includes('transactionsSince')) {
        hits.push({ file: file.name, line: index + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

export function assertTimersAvoidFullHistory(files: SourceFile[]): void {
  const hits = findFullHistoryInTimers(files);
  if (hits.length === 0) return;
  const detail = hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`).join('\n');
  throw new Error(`getTransactionsForAddress is banned from timer loops:\n${detail}`);
}
