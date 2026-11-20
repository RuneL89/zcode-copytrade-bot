import type { DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { TelegramNotifier, TelegramUpdate } from '@zcode-bot/providers';

/**
 * Read-only Telegram commands (operator choice, 2026-11-03): the operator can
 * ask the bot for the desk status from the phone. Nothing typed in Telegram can
 * change trading state — control stays in the dashboard, behind the session
 * cookie and the FIRE word.
 *
 * Transport lives in `packages/providers/src/notify.ts`; this service owns the
 * long-poll loop, the operator-chat allow-list and the audit trail, and its
 * start/stop is owned by `runtime.ts` (the services contract: no unbounded loop
 * starts itself).
 */

export type TelegramCommand = 'status' | 'positions' | 'help' | 'unknown';

/** Long-poll hold time; Telegram allows up to 50s. */
const POLL_TIMEOUT_SECONDS = 25;
/** A command older than this is backlog (a fresh boot must not replay it). */
const STALE_COMMAND_MS = 120_000;
/** One answer per command kind inside this window, so a double-tap is quiet. */
const COMMAND_COOLDOWN_MS = 5_000;
/** Poll failures are audited at most once per window (never once per retry). */
const FAILURE_AUDIT_INTERVAL_MS = 300_000;

/**
 * The command list is published to Telegram on start, so typing "/" in the chat
 * pops up a menu with descriptions. One source of truth: the help text is built
 * from the same rows, so the menu and the reply cannot drift apart.
 */
export const BOT_COMMANDS = [
  { command: 'status', description: '24h desk summary', help: '/status — 24h desk summary' },
  {
    command: 'positions',
    description: 'Open positions and their time exits',
    help: '/positions — every open position and its time exit',
  },
  { command: 'help', description: 'Command list', help: '/help — this list' },
] as const;

export const HELP_TEXT = ['Copydesk commands (read-only):', ...BOT_COMMANDS.map((c) => c.help)].join('\n');

/**
 * Parse one message into a command. Tolerates `/Status`, `/status@CopydeskBot`
 * and surrounding whitespace; returns null when the text is not a command, and
 * 'unknown' for a `/command` this bot does not serve.
 */
export function parseCommand(text: string | null): TelegramCommand | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const word = trimmed.slice(1).split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';
  switch (word) {
    case 'status':
      return 'status';
    case 'positions':
      return 'positions';
    case 'help':
    case 'start':
      return 'help';
    case '':
      return null;
    default:
      return 'unknown';
  }
}

export interface TelegramCommandTexts {
  status: () => Promise<string>;
  positions: () => Promise<string>;
}

export class TelegramCommandService {
  private stopped = true;
  private running = false;
  private backoffMs = 1000;
  private lastFailureAuditAt = 0;
  private lastFailureMessage = '';
  private readonly lastAnsweredAt = new Map<TelegramCommand, number>();
  private readonly foreignChatsSeen = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private db: DbHandle,
    private bot: TelegramNotifier,
    private operatorChatId: string,
    private texts: TelegramCommandTexts,
    /** Test seam: keeps a poll-failure backoff from waiting in tests. */
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.sleep = sleep;
  }

  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    void this.registerCommands();
    void this.loop().finally(() => {
      this.running = false;
    });
  }

  /**
   * Publish the "/" menu (idempotent, once per start). A failure is audited and
   * never blocks the loop: the commands still work when typed by hand.
   */
  async registerCommands(): Promise<void> {
    try {
      await this.bot.setCommands(
        BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })),
        this.operatorChatId,
      );
      await this.bot.setMenuButton(this.operatorChatId);
      repo.audit(this.db.db, 'telegram', `command menu registered (${BOT_COMMANDS.length} commands)`, {});
    } catch (e) {
      repo.audit(this.db.db, 'telegram', `command menu registration failed: ${(e as Error).message}`, {});
    }
  }

  /** Ends the loop; an in-flight poll resolves within its own request timeout. */
  stop(): void {
    this.stopped = true;
  }

  /** The offset Telegram should resume from (persisted across restarts). */
  private offset(): number {
    return Number(repo.kvGet(this.db.db, 'telegram.lastUpdateId') ?? '0');
  }

  private setOffset(updateId: number): void {
    repo.kvSet(this.db.db, 'telegram.lastUpdateId', String(updateId + 1));
  }

  /** Never throws: a transport failure is audited (throttled) and retried. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.bot.getUpdates(this.offset(), POLL_TIMEOUT_SECONDS);
        this.backoffMs = 1000;
        if (updates.length === 0) {
          // Telegram normally holds the poll open for the whole timeout. An
          // instant empty answer (a proxy, or a test double) must not turn this
          // into a hot loop, so pause briefly before asking again.
          await this.sleep(250);
          continue;
        }
        for (const update of updates) {
          this.setOffset(update.updateId);
          if (this.stopped) return;
          await this.handle(update);
        }
      } catch (e) {
        if (this.stopped) return;
        this.reportFailure((e as Error).message);
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      }
    }
  }

  private reportFailure(message: string): void {
    const now = Date.now();
    // The same failure repeated is one problem, not one per retry.
    if (message === this.lastFailureMessage && now - this.lastFailureAuditAt < FAILURE_AUDIT_INTERVAL_MS) {
      return;
    }
    this.lastFailureAuditAt = now;
    this.lastFailureMessage = message;
    const hint = /HTTP 409/.test(message)
      ? ' (another process is polling this bot, or a webhook is set — only one consumer is allowed)'
      : '';
    repo.audit(this.db.db, 'telegram', `command poll failed: ${message}${hint}`, {});
  }

  /** Answer one update. Only the operator chat may command the bot. */
  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.chatId === null) return;
    if (update.chatId !== this.operatorChatId) {
      if (!this.foreignChatsSeen.has(update.chatId)) {
        this.foreignChatsSeen.add(update.chatId);
        repo.audit(this.db.db, 'telegram', 'command ignored: message from a chat that is not the operator', {
          chatId: update.chatId,
        });
      }
      return;
    }
    const command = parseCommand(update.text);
    if (command === null) return; // plain chatter is not a command
    // Backlog from before this process started: consumed (the offset moved),
    // never answered — a stale /status reply reads as a live one.
    if (update.dateSeconds > 0 && Date.now() - update.dateSeconds * 1000 > STALE_COMMAND_MS) {
      repo.audit(this.db.db, 'telegram', `command skipped: stale ${update.text ?? ''}`.slice(0, 200), {});
      return;
    }
    if (command !== 'unknown') {
      const lastAt = this.lastAnsweredAt.get(command) ?? 0;
      if (Date.now() - lastAt < COMMAND_COOLDOWN_MS) return; // a double-tap, not a second question
      this.lastAnsweredAt.set(command, Date.now());
    }
    try {
      if (command === 'help' || command === 'unknown') {
        await this.reply(HELP_TEXT, update.messageId);
        repo.audit(
          this.db.db,
          'telegram',
          `command ${command === 'help' ? '/help' : 'unknown'} answered with usage`,
          {},
        );
        return;
      }
      const text = await this.textFor(command);
      await this.reply(text, update.messageId);
      repo.audit(
        this.db.db,
        'telegram',
        `command /${command} answered (${text.split('\n').length} lines)`,
        {},
      );
    } catch (e) {
      repo.audit(this.db.db, 'telegram', `command /${command} failed: ${(e as Error).message}`, {});
    }
  }

  private textFor(command: Exclude<TelegramCommand, 'help' | 'unknown'>): Promise<string> {
    if (command === 'status') return this.texts.status();
    return this.texts.positions();
  }

  private async reply(text: string, replyToMessageId: number | null): Promise<void> {
    await this.bot.send(text, replyToMessageId ?? undefined);
  }
}
