/** Optional notification adapters. Telegram is opt-in only. */
export interface Notifier {
  readonly name: string;
  notify(message: string): Promise<void>;
}

export class NoopNotifier implements Notifier {
  readonly name = 'noop';
  async notify(): Promise<void> {}
}

export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  constructor(
    private botToken: string,
    private chatId: string,
  ) {}
  async notify(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: message }),
    });
    if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
  }
}

export function notifierFromEnv(botToken: string, chatId: string): Notifier {
  return botToken && chatId ? new TelegramNotifier(botToken, chatId) : new NoopNotifier();
}
