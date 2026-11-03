import { describe, expect, it } from 'vitest';
import {
  isTelegramNotifier,
  NoopNotifier,
  notifierFromEnv,
  TelegramNotifier,
  type FetchLike,
} from '../src/notify.js';

/** Records every call and replies with a scripted body. */
function fakeFetch(
  body: unknown,
  ok = true,
): { calls: Array<{ url: string; init?: RequestInit }>; impl: FetchLike } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
  };
  return { calls, impl };
}

const body = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

describe('TelegramNotifier', () => {
  it('sends to the configured chat and marks link previews off', async () => {
    const { calls, impl } = fakeFetch({ ok: true });
    const bot = new TelegramNotifier('TOKEN', 'CHAT', impl);
    await bot.notify('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(body(calls[0]!.init)).toMatchObject({
      chat_id: 'CHAT',
      text: 'hello',
      link_preview_options: { is_disabled: true },
    });
  });

  it('threads a reply when given a message id', async () => {
    const { calls, impl } = fakeFetch({ ok: true });
    const bot = new TelegramNotifier('TOKEN', 'CHAT', impl);
    await bot.send('reply text', 42);
    expect(body(calls[0]!.init)).toMatchObject({ reply_to_message_id: 42 });
  });

  it('throws on a non-OK send so the caller can report it', async () => {
    const { impl } = fakeFetch({}, false);
    const bot = new TelegramNotifier('TOKEN', 'CHAT', impl);
    await expect(bot.notify('x')).rejects.toThrow(/telegram: HTTP 500/);
  });

  it('normalizes getUpdates into message rows and never returns raw payloads', async () => {
    const { calls, impl } = fakeFetch({
      ok: true,
      result: [
        {
          update_id: 7,
          message: { message_id: 11, date: 1_760_000_000, text: '/status', chat: { id: 555 } },
        },
        { update_id: 8, edited_message: { message_id: 12, chat: { id: 555 } } }, // not a message
      ],
    });
    const bot = new TelegramNotifier('TOKEN', 'CHAT', impl);
    const updates = await bot.getUpdates(7, 25);
    expect(updates).toEqual([
      { updateId: 7, chatId: '555', messageId: 11, text: '/status', dateSeconds: 1_760_000_000 },
      { updateId: 8, chatId: null, messageId: null, text: null, dateSeconds: 0 },
    ]);
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTOKEN/getUpdates');
    expect(body(calls[0]!.init)).toMatchObject({ offset: 7, timeout: 25, allowed_updates: ['message'] });
  });

  it('refuses a getUpdates body that reports failure', async () => {
    const { impl } = fakeFetch({ ok: false, description: 'Conflict: terminated by other getUpdates' });
    const bot = new TelegramNotifier('TOKEN', 'CHAT', impl);
    await expect(bot.getUpdates(0, 25)).rejects.toThrow(/getUpdates refused/);
  });

  it('is off by default: no token or chat means the noop notifier', () => {
    expect(isTelegramNotifier(notifierFromEnv('', ''))).toBe(false);
    expect(notifierFromEnv('', '')).toBeInstanceOf(NoopNotifier);
    expect(isTelegramNotifier(notifierFromEnv('TOKEN', 'CHAT'))).toBe(true);
  });

  it('says nothing when a chat is missing (no request is attempted)', async () => {
    const { calls, impl } = fakeFetch({ ok: true });
    await new TelegramNotifier('TOKEN', '', impl).notify('x');
    expect(calls).toHaveLength(0);
  });
});
