/** Optional notification adapters. Telegram is opt-in only. */
export interface Notifier {
  readonly name: string;
  notify(message: string): Promise<void>;
}

export class NoopNotifier implements Notifier {
  readonly name = 'noop';
  async notify(): Promise<void> {}
}

/** One inbound message, normalized (the poller never sees raw Telegram JSON). */
export interface TelegramUpdate {
  updateId: number;
  chatId: string | null;
  messageId: number | null;
  text: string | null;
  /** Message time, unix seconds, as Telegram reports it (0 when absent). */
  dateSeconds: number;
}

/** Minimal fetch surface, injectable so no test can reach the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  private readonly fetchImpl: FetchLike;

  constructor(
    private botToken: string,
    private chatId: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  async notify(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    await this.send(message);
  }

  /** Post to the configured chat, optionally threaded under a message. */
  async send(text: string, replyToMessageId?: number): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    await this.post('sendMessage', {
      chat_id: this.chatId,
      text,
      ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * Long-poll for new messages. `timeoutSeconds` is Telegram's own hold time
   * (0..50); the HTTP request outlives it by a margin so a slow reply is not
   * mistaken for a dead connection. Updates are normalized here — the caller
   * never parses Telegram's payload shape.
   */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    if (!this.botToken) return [];
    const res = await this.fetchImpl(this.api('getUpdates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
    });
    if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; result?: unknown[] };
    if (body.ok === false) throw new Error('telegram: getUpdates refused');
    const rows = Array.isArray(body.result) ? body.result : [];
    return rows.map((raw) => {
      const u = raw as {
        update_id?: number;
        message?: { message_id?: number; date?: number; text?: string; chat?: { id?: number | string } };
      };
      return {
        updateId: typeof u.update_id === 'number' ? u.update_id : 0,
        chatId: u.message?.chat?.id === undefined ? null : String(u.message.chat.id),
        messageId: u.message?.message_id ?? null,
        text: u.message?.text ?? null,
        dateSeconds: u.message?.date ?? 0,
      };
    });
  }

  /**
   * Publish the command list so Telegram's clients show a "/" menu with
   * descriptions (the operator never has to remember the names). Scoped to the
   * operator's chat, so the bot does not advertise commands anywhere else.
   * Idempotent: safe to call on every start.
   */
  async setCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
    scopeChatId?: string,
  ): Promise<void> {
    if (!this.botToken) return;
    await this.post('setMyCommands', {
      commands,
      ...(scopeChatId ? { scope: chatScope(scopeChatId) } : {}),
    });
  }

  /** Point the chat's menu button at the command list. */
  async setMenuButton(chatId?: string): Promise<void> {
    if (!this.botToken) return;
    await this.post('setChatMenuButton', {
      ...(chatId && /^-?\d+$/.test(chatId) ? { chat_id: Number(chatId) } : {}),
      menu_button: { type: 'commands' },
    });
  }

  private async post(method: string, payload: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(this.api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({ ok: true }))) as { ok?: boolean; description?: string };
    if (body.ok === false) throw new Error(`telegram: ${method} refused: ${body.description ?? 'unknown'}`);
  }
}

/** Telegram wants a numeric chat id for chat scope; handles may pass through. */
function chatScope(chatId: string): Record<string, unknown> {
  return { type: 'chat', chat_id: /^-?\d+$/.test(chatId) ? Number(chatId) : chatId };
}

export function notifierFromEnv(botToken: string, chatId: string, fetchImpl?: FetchLike): Notifier {
  return botToken && chatId ? new TelegramNotifier(botToken, chatId, fetchImpl) : new NoopNotifier();
}

/** True for the real Telegram adapter (the only one that can receive commands). */
export function isTelegramNotifier(n: Notifier): n is TelegramNotifier {
  return n instanceof TelegramNotifier;
}
