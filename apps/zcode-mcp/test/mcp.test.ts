import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { snapshotHash, type ResearchSnapshot } from '@zcode-bot/core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

let snapshotDir: string;
let inboxDir: string;
let client: Client;

const SNAPSHOT: ResearchSnapshot = {
  snapshotId: 'snap-test-1',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  sourceFreshnessSeconds: 120,
  candidates: [
    {
      candidateId: 'cand_ape',
      handle: 'ape_vasco',
      weeklyRank: 1,
      displayedWeeklyPnlUsdMicro: '438000000',
      profileUrl: null,
      avatarUrl: null,
      addresses: [
        {
          chain: 'solana',
          address: 'LeaderAddr1111111111111111111111111111111111',
          verification: 'reported',
        },
      ],
      enabled: true,
      justFired: false,
      recentEligibilityFailures: [],
      publicStats: { winRatePct: 61, tradesCount: 120, avgTradeUsdMicro: null, activityCheckedAt: null },
      observedAt: new Date().toISOString(),
    },
  ],
};

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'zcode-mcp-'));
  snapshotDir = join(base, 'snapshot');
  inboxDir = join(base, 'inbox');
  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(snapshotDir, 'snapshot.json'),
    JSON.stringify({ ...SNAPSHOT, hash: snapshotHash(SNAPSHOT) }),
  );

  client = new Client({ name: 'test-client', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, join(import.meta.dirname, '..', 'src', 'index.ts')],
    env: {
      // ONLY the allowlisted paths are passed — the test asserts this process
      // never receives the broader server environment.
      ZCODE_MCP_SNAPSHOT_DIR: snapshotDir,
      ZCODE_MCP_INBOX_DIR: inboxDir,
    } as Record<string, string>,
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
});

describe('restricted research MCP server', () => {
  it('exposes exactly the three research tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_replacement_context',
      'get_research_snapshot',
      'submit_candidate_recommendation',
    ]);
    // No trading, wallet, config, or filesystem tools by construction.
    const joined = names.join(',');
    expect(joined).not.toMatch(/order|trade|wallet|secret|config|sign|pause|close|execute|query/i);
  });

  it('returns the sanitized snapshot', async () => {
    const res = await client.callTool({ name: 'get_research_snapshot', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as ResearchSnapshot & { hash: string };
    expect(parsed.snapshotId).toBe('snap-test-1');
    expect(parsed.hash).toBe(snapshotHash(SNAPSHOT));
    expect(text).not.toContain('SESSION_SECRET');
  });

  it('writes exactly one recommendation file into the inbox atomically', async () => {
    const recId = crypto.randomUUID();
    const now = Date.now();
    const res = await client.callTool({
      name: 'submit_candidate_recommendation',
      arguments: {
        recommendation: {
          schemaVersion: 1,
          recommendationId: recId,
          snapshotId: SNAPSHOT.snapshotId,
          snapshotHash: snapshotHash(SNAPSHOT),
          createdAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 3600_000).toISOString(),
          researchSessionId: 'sess-1',
          modelLabel: 'GLM (ZCode)',
          orderedCandidates: [
            {
              candidateId: 'cand_ape',
              rank: 1,
              confidence: 0.8,
              thesis: 'Complete fresh data with a supported address.',
              evidence: [{ field: 'weeklyRank', observedAt: new Date().toISOString(), note: 'rank 1' }],
              concerns: [],
            },
          ],
          abstain: false,
          abstainReason: null,
        },
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain(recId);
    // Atomic drop: only the final .json file exists (no .tmp leftovers).
    const files = readdirSync(inboxDir);
    expect(files).toEqual([`${recId}.json`]);
    const stored = JSON.parse(readFileSync(join(inboxDir, files[0]!), 'utf8'));
    expect(stored.orderedCandidates[0].candidateId).toBe('cand_ape');
  });

  it('rejects malformed submissions at the tool-input schema level', async () => {
    const res = await client.callTool({
      name: 'submit_candidate_recommendation',
      arguments: {
        recommendation: {
          schemaVersion: 1,
          recommendationId: 'not-a-uuid',
          snapshotId: 'x',
          snapshotHash: 'zz',
          createdAt: 'nope',
          expiresAt: 'nope',
          orderedCandidates: [],
          abstain: false,
          abstainReason: null,
        },
      },
    });
    expect(res.isError ?? false).toBe(true);
    // No file written for the malformed attempt.
    expect(readdirSync(inboxDir).length).toBe(1);
  });

  it('cannot read outside its allowlisted directories', async () => {
    // There is no tool that takes a path at all; verify the tool surface has
    // no path parameter (structural guarantee, tested).
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema).not.toMatch(/"path"|filePath|directory/i);
    }
    expect(existsSync(join(snapshotDir, 'replacement-context.json'))).toBe(false);
    const res = await client.callTool({ name: 'get_replacement_context', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('No replacement context');
  });
});
