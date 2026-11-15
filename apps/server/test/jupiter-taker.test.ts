import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const CALL_SITES = [
  'apps/server/src/services/executors.ts',
  'apps/server/src/runtime.ts',
  'packages/providers/src/price.ts',
  'packages/providers/src/solana/jupiter.ts',
];

/** Every Jupiter `/build` quote object passes `taker`. The method definition is not a call. */
function quoteCallsMissingTaker(source: string): number[] {
  const lines = source.split('\n');
  const missing: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('.quote(')) continue;
    const window = lines.slice(i, i + 12).join('\n');
    if (!window.includes('taker')) missing.push(i + 1);
  }
  return missing;
}

describe('Jupiter quote taker', () => {
  it('every quote call site sends taker', () => {
    const misses: string[] = [];
    for (const file of CALL_SITES) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      for (const line of quoteCallsMissingTaker(source)) misses.push(`${file}:${line}`);
    }
    expect(misses).toEqual([]);
  });
});
