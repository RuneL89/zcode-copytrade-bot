import { describe, expect, it } from 'vitest';
import {
  extractReplyTail,
  hoursAgoFrom,
  isFullSolanaAddress,
  parseDawnMoney,
  parseDawnTraderReply,
  tailLooksLikeTraderCard,
} from '../src/dawn/dawn-lookup.js';

// Reconstructed from the Dawn trader card the operator sees (multi-line layout).
const CARD_MULTILINE = [
  'point farm capital',
  'fomo trader',
  'PnL on fomo',
  '+$1.6M',
  'Win 13%',
  'Swaps 1,696',
  'Realized on-chain',
  '−$93.6K', // Unicode minus, as Dawn renders it
  'Wallets',
  'Solana',
  'Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit',
  'Copy',
  'EVM',
  '0xfd87eda88be6c372453b721da63d58ad1a5b2d94',
  'Copy',
].join('\n');

const CARD_COMPACT =
  'Werey @motiyawerey PnL on fomo +$272.7K Win 10% Realized on-chain −$18.2K Wallets Solana ' +
  '4Nd1mS7o1vE7QQZceVe3yHqVLcuLWumMrp3EbYgvKcbn Copy EVM 0xabc0000000000000000000000000000000000999 Copy';

describe('dawn reply parsing', () => {
  it('extracts wallets, PnL, realized and win rate from a trader card', () => {
    const parsed = parseDawnTraderReply(CARD_MULTILINE);
    expect(parsed.solanaAddress).toBe('Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit');
    expect(parsed.evmAddress).toBe('0xfd87eda88be6c372453b721da63d58ad1a5b2d94');
    expect(parsed.pnlOnFomoUsd).toBe(1_600_000);
    expect(parsed.realizedOnchainUsd).toBe(-93_600);
    expect(parsed.winRatePct).toBe(13);
  });

  it('parses a compact single-line card', () => {
    const parsed = parseDawnTraderReply(CARD_COMPACT);
    expect(parsed.solanaAddress).toBe('4Nd1mS7o1vE7QQZceVe3yHqVLcuLWumMrp3EbYgvKcbn');
    expect(parsed.evmAddress).toBe('0xabc0000000000000000000000000000000000999');
    expect(parsed.pnlOnFomoUsd).toBeCloseTo(272_700, 6);
    expect(parsed.realizedOnchainUsd).toBeCloseTo(-18_200, 6);
    expect(parsed.winRatePct).toBe(10);
  });

  it('never mistakes EVM hex for a Solana address', () => {
    const parsed = parseDawnTraderReply('Wallets EVM 0xfd87eda88be6c372453b721da63d58ad1a5b2d94 Copy');
    expect(parsed.solanaAddress).toBeNull();
    expect(parsed.evmAddress).toBe('0xfd87eda88be6c372453b721da63d58ad1a5b2d94');
  });

  it('returns nulls for unparseable text instead of throwing', () => {
    const parsed = parseDawnTraderReply('Hi! Use the buttons below to deposit.');
    expect(parsed.solanaAddress).toBeNull();
    expect(parsed.evmAddress).toBeNull();
    expect(parsed.pnlOnFomoUsd).toBeNull();
    expect(parsed.realizedOnchainUsd).toBeNull();
    expect(parsed.winRatePct).toBeNull();
  });
});

// Captured verbatim from a Dawn reply to a pasted profile link (2026-10-28).
const COMPACT_TVMX = [
  ' @tvmx on fomo · 348.1K followers',
  '├ SOL: F5hkYsi8JxjyA2JHN5CA7MbnnhWubkXB2ZQB7Gkaxqs6',
  '└ EVM: 0xa0670863bd5cd0d60022bab2eed78e81e1a06bce',
  '',
  'PnL',
  '├ 24h: ',
  ' +$390.1K · #5',
  '├ 7d: ',
  ' +$377.1K · #3',
  '├ 30d: ',
  ' -$2.85M',
  '└ All time: ',
  ' +$2.18M · #7',
  '',
  'Trading',
  '├ Trades: 4,458 · Volume: $4.44M',
  '├ Recent buys / sells: 7 / 12',
  '├ Coins: 11',
  '└ Last trade: 8h ago',
].join('\n');

const COMPACT_LUCKYNIU = [
  ' @luckyniu on fomo · 12,547 followers',
  '├ SOL: 4GELppbfrevo3eQ8nAywmN2irRrCeGTSmQ19vwzyTS8P',
  '└ EVM: 0x04e4ba53f19b3e4deb4a78ca9543b7e92a228199',
  '',
  'PnL',
  '├ 24h: ',
  ' +$68,248.90 · #79',
  '├ 7d: ',
  ' +$90,160.51 · #15',
  '├ 30d: ',
  ' -$252.3K',
  '└ All time: ',
  ' -$435.5K',
  '',
  'Trading',
  '├ Trades: 611 · Volume: $8.03M',
  '├ Recent buys / sells: 24 / 7',
  '├ Coins: 12',
  '└ Last trade: 1h ago',
].join('\n');

describe('dawn compact card (PnL periods + trading block)', () => {
  it('parses per-period PnL, ranks and the trading block', () => {
    const p = parseDawnTraderReply(COMPACT_TVMX);
    expect(p.solanaAddress).toBe('F5hkYsi8JxjyA2JHN5CA7MbnnhWubkXB2ZQB7Gkaxqs6');
    expect(p.pnl24hUsd).toBeCloseTo(390_100, 6);
    expect(p.pnl7dUsd).toBeCloseTo(377_100, 6);
    expect(p.pnl30dUsd).toBeCloseTo(-2_850_000, 6);
    expect(p.pnlAllTimeUsd).toBeCloseTo(2_180_000, 6);
    expect(p.rank24h).toBe(5);
    expect(p.rank7d).toBe(3);
    expect(p.rankAllTime).toBe(7);
    expect(p.tradesTotal).toBe(4458);
    expect(p.volumeUsd).toBeCloseTo(4_440_000, 6);
    expect(p.recentBuys).toBe(7);
    expect(p.recentSells).toBe(12);
    expect(p.coinsTraded).toBe(11);
    expect(p.lastTradeAgeHours).toBe(8);
    expect(p.cardVariant).toBe('compact-pnl');
    // The compact card never carries the rich-card fields.
    expect(p.realizedOnchainUsd).toBeNull();
    expect(p.winRatePct).toBeNull();
  });

  it('handles comma amounts and a missing all-time rank', () => {
    const p = parseDawnTraderReply(COMPACT_LUCKYNIU);
    expect(p.pnl24hUsd).toBeCloseTo(68_248.9, 6);
    expect(p.pnl7dUsd).toBeCloseTo(90_160.51, 6);
    expect(p.pnl30dUsd).toBeCloseTo(-252_300, 6);
    expect(p.pnlAllTimeUsd).toBeCloseTo(-435_500, 6);
    expect(p.rank24h).toBe(79);
    expect(p.rank7d).toBe(15);
    expect(p.rankAllTime).toBeNull();
    expect(p.tradesTotal).toBe(611);
    expect(p.volumeUsd).toBeCloseTo(8_030_000, 6);
    expect(p.recentBuys).toBe(24);
    expect(p.recentSells).toBe(7);
    expect(p.lastTradeAgeHours).toBe(1);
    expect(p.cardVariant).toBe('compact-pnl');
  });

  it('marks a wallet-only reply as addresses-only', () => {
    const p = parseDawnTraderReply('Wallets Solana Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit Copy');
    expect(p.solanaAddress).toBe('Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit');
    expect(p.pnl7dUsd).toBeNull();
    expect(p.cardVariant).toBe('addresses-only');
  });

  it('classifies the legacy rich card as rich', () => {
    expect(parseDawnTraderReply(CARD_MULTILINE).cardVariant).toBe('rich');
    expect(parseDawnTraderReply('Hi! Use the buttons below to deposit.').cardVariant).toBe('unknown');
  });
});

describe('dawn last-trade parsing', () => {
  it('converts minutes, hours and days to hours', () => {
    expect(hoursAgoFrom('Last trade: 8h ago')).toBe(8);
    expect(hoursAgoFrom('Last trade: 25m ago')).toBeCloseTo(25 / 60, 6);
    expect(hoursAgoFrom('Last trade: 2d ago')).toBe(48);
    expect(hoursAgoFrom('Last trade: just now')).toBe(0);
    expect(hoursAgoFrom('no trading block')).toBeNull();
  });
});

describe('dawn money parsing', () => {
  it('handles K/M suffixes, commas and the Unicode minus', () => {
    expect(parseDawnMoney('+$1.6M')).toBe(1_600_000);
    expect(parseDawnMoney('−$93.6K')).toBe(-93_600);
    expect(parseDawnMoney('$272.7K')).toBeCloseTo(272_700, 6);
    expect(parseDawnMoney('-$1,234.56')).toBeCloseTo(-1234.56, 6);
    expect(parseDawnMoney('+$574.1K')).toBeCloseTo(574_100, 6);
  });

  it('returns null without an amount', () => {
    expect(parseDawnMoney('no numbers here')).toBeNull();
  });
});

describe('solana address shape', () => {
  const a43 = 'Leader1' + '1'.repeat(36); // 43 chars, valid base58 alphabet
  it('accepts 43–44 char base58 and rejects lookalikes', () => {
    expect(isFullSolanaAddress(a43)).toBe(true);
    expect(isFullSolanaAddress(a43 + '1')).toBe(true);
    expect(isFullSolanaAddress(a43.slice(1))).toBe(false);
    expect(isFullSolanaAddress('l0O1' + '1'.repeat(39))).toBe(false); // excluded alphabet chars
    expect(isFullSolanaAddress('0xfd87eda88be6c372453b721da63d58ad1a5b2d94')).toBe(false);
  });
});

describe('reply tail isolation', () => {
  const bubbles = ['⚙️ Main menu — Deposit / Trade / Copytrade', '@unipcs', CARD_MULTILINE];

  it('isolates text after our outgoing message', () => {
    const tail = extractReplyTail(bubbles, '@unipcs');
    expect(tail).toContain('Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit');
    expect(tailLooksLikeTraderCard(tail)).toBe(true);
  });

  it('returns empty when our message is not among the bubbles', () => {
    expect(extractReplyTail([CARD_MULTILINE], '@unipcs')).toBe('');
    expect(tailLooksLikeTraderCard('Hi! Use the buttons below to deposit.')).toBe(false);
  });
});
