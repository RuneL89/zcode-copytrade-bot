import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { TelegramNotifier, TelegramUpdate } from '@zcode-bot/providers';
import { HELP_TEXT, parseCommand, TelegramCommandService } from '../src/services/telegram-commands.js';

/**
 * Read-only Telegram commands: the operator chat may ask for the desk status,
 * every other chat is ignored, an old command is never replayed as a fresh
 * answer, and a transport failure never stops the loop.
 */

let dir: string;
let handle: DbHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-telegram-'));
  handle = openDatabase(dir);
  migrate(handle.db, {
    migrationsFolder: resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      '..',
      'packages',
      'db',
      'drizzle',
    ),
  });
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const OPERATOR = '555';

/** Bot stub: scripted poll pages, recorded sends, and a stop latch. */
function botStub(pages: Array<TelegramUpdate[] | Error>) {
  const sent: Array<{ text: string; replyTo?: number }> = [];
  let polls = 0;
  const bot = {
    name: 'telegram',
    notify: async () => {},
    send: async (text: string, replyTo?: number) => {
      sent.push({ text, replyTo });
    },
    getUpdates: async () => {
      const page = pages[Math.min(polls, pages.length - 1)];
      polls++;
      if (page instanceof Error) throw page;
      return page;
    },
  } as unknown as TelegramNotifier;
  return { bot, sent, polls: () => polls };
}

const message = (over: Partial<TelegramUpdate> = {}): TelegramUpdate => ({
  updateId: 1,
  chatId: OPERATOR,
  messageId: 10,
  text: '/status',
  dateSeconds: Math.floor(Date.now() / 1000),
  ...over,
});

function serviceFor(
  pages: Array<TelegramUpdate[] | Error>,
  texts: Partial<{ status: string; weekly: string; positions: string }> = {},
) {
  const stub = botStub(pages);
  const svc = new TelegramCommandService(
    handle,
    stub.bot,
    OPERATOR,
    {
      status: async () => texts.status ?? 'STATUS TEXT\nline 2',
      weekly: async () => texts.weekly ?? 'WEEKLY TEXT',
      positions: async () => texts.positions ?? 'POSITIONS TEXT',
    },
    yieldToTimers, // no real waiting between poll attempts
  );
  return { svc, ...stub };
}

/** A sleep that still yields the macrotask queue, so test timers keep firing. */
const yieldToTimers = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 1)));

/** Run poll iterations by hand: start, spin briefly, then stop the loop. */
async function drain(svc: TelegramCommandService): Promise<void> {
  svc.start();
  for (let i = 0; i < 50 && svcRunning(svc); i++) await new Promise((r) => setTimeout(r, 1));
  svc.stop();
  await new Promise((r) => setTimeout(r, 5));
}

const svcRunning = (svc: TelegramCommandService): boolean => (svc as unknown as { running: boolean }).running;

describe('parseCommand', () => {
  it('reads the commands the bot serves, in any casing or with a bot suffix', () => {
    expect(parseCommand('/status')).toBe('status');
    expect(parseCommand('  /STATUS ')).toBe('status');
    expect(parseCommand('/status@CopydeskBot')).toBe('status');
    expect(parseCommand('/weekly')).toBe('weekly');
    expect(parseCommand('/positions extra argument')).toBe('positions');
    expect(parseCommand('/help')).toBe('help');
    expect(parseCommand('/start')).toBe('help'); // Telegram's own entry command
  });

  it('separates plain chatter from an unknown command', () => {
    expect(parseCommand('hello there')).toBe(null);
    expect(parseCommand('')).toBe(null);
    expect(parseCommand(null)).toBe(null);
    expect(parseCommand('/pause now')).toBe('unknown');
    expect(parseCommand('/')).toBe(null);
  });
});

describe('TelegramCommandService', () => {
  it('answers /status in the operator chat, threaded under the request', async () => {
    const h = serviceFor([[message()], []]);
    await drain(h.svc);
    expect(h.sent).toEqual([{ text: 'STATUS TEXT\nline 2', replyTo: 10 }]);
    expect(
      repo.listAudit(handle.db, 5).some((a) => /command \/status answered \(2 lines\)/.test(a.message)),
    ).toBe(true);
  });

  it('serves /weekly and /positions from the injected builders', async () => {
    const weekly = serviceFor([[message({ updateId: 20, text: '/weekly' })], []]);
    await drain(weekly.svc);
    expect(weekly.sent[0]!.text).toBe('WEEKLY TEXT');

    const positions = serviceFor([[message({ updateId: 30, text: '/positions' })], []]);
    await drain(positions.svc);
    expect(positions.sent[0]!.text).toBe('POSITIONS TEXT');
  });

  it('answers an unknown command with the usage list and never with state', async () => {
    const h = serviceFor([[message({ updateId: 40, text: '/pause' })], []]);
    await drain(h.svc);
    expect(h.sent[0]!.text).toBe(HELP_TEXT);
  });

  it('ignores another chat entirely, and says so once in the audit trail', async () => {
    const h = serviceFor([
      [message({ updateId: 50, chatId: '999' }), message({ updateId: 51, chatId: '999' })],
      [],
    ]);
    await drain(h.svc);
    expect(h.sent).toHaveLength(0);
    const lines = repo.listAudit(handle.db, 20).filter((a) => /not the operator/.test(a.message));
    expect(lines).toHaveLength(1);
  });

  it('consumes a stale backlog command without answering it', async () => {
    const old = message({ updateId: 60, dateSeconds: Math.floor(Date.now() / 1000) - 3600 });
    const h = serviceFor([[old], []]);
    await drain(h.svc);
    expect(h.sent).toHaveLength(0);
    expect(repo.listAudit(handle.db, 20).some((a) => /command skipped: stale/.test(a.message))).toBe(true);
    // The offset still moved, so the backlog cannot be replayed later.
    expect(repo.kvGet(handle.db, 'telegram.lastUpdateId')).toBe('61');
  });

  it('persists the offset so a restart does not replay what was already answered', async () => {
    repo.kvSet(handle.db, 'telegram.lastUpdateId', '0');
    const first = serviceFor([[message({ updateId: 70, text: '/help' })], []]);
    await drain(first.svc);
    expect(repo.kvGet(handle.db, 'telegram.lastUpdateId')).toBe('71');

    // A fresh service resumes from the stored offset and asks Telegram for it.
    const seen: number[] = [];
    const stub = botStub([[]]);
    const svc = new TelegramCommandService(
      handle,
      {
        ...(stub.bot as unknown as Record<string, unknown>),
        getUpdates: async (offset: number) => {
          seen.push(offset);
          return [];
        },
      } as unknown as TelegramNotifier,
      OPERATOR,
      { status: async () => '', weekly: async () => '', positions: async () => '' },
      yieldToTimers,
    );
    await drain(svc);
    expect(seen[0]).toBe(71);
  });

  it('audits a transport failure (with the 409 hint) and keeps polling', async () => {
    const h = serviceFor([new Error('telegram: HTTP 409'), [], []]);
    await drain(h.svc);
    const failure = repo.listAudit(handle.db, 20).find((a) => /command poll failed/.test(a.message));
    expect(failure?.message).toMatch(/another process is polling/);
    expect(h.polls()).toBeGreaterThan(1); // the loop survived the failure
  });

  it('reports a failing builder instead of going silent', async () => {
    const stub = botStub([[message({ updateId: 90 })], []]);
    const svc = new TelegramCommandService(
      handle,
      stub.bot,
      OPERATOR,
      {
        status: async () => {
          throw new Error('state unavailable');
        },
        weekly: async () => '',
        positions: async () => '',
      },
      yieldToTimers,
    );
    await drain(svc);
    expect(
      repo.listAudit(handle.db, 10).some((a) => /command \/status failed: state unavailable/.test(a.message)),
    ).toBe(true);
  });
});
