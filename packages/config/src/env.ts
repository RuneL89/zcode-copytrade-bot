import { z } from 'zod';
import { modeSchema, riskConfigSchema, DEFAULT_RISK, type Mode, type RiskConfig } from './risk.js';

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['1', 'true', 'yes', '0', 'false', 'no']).transform((v) => ['1', 'true', 'yes'].includes(v)));

const port = z.coerce.number().int().positive().max(65535);
const intervalMs = z.coerce.number().int().positive();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MODE: modeSchema.default('paper'),
  PORT: port.default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('./data'),
  /** Paper-mode starting bankroll in USD (dashboard equity baseline). */
  EQUITY_START_USD: z.coerce.number().positive().default(100),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  LIVE_TRADING_ACK: z.string().optional(),
  /**
   * Hard switch for signing. Default false. MODE=live still refuses to sign
   * until this is true, and a true value refuses to boot if the P1 acceptance
   * checks fail.
   */
  LIVE_TRADING: z
    .string()
    .default('false')
    .transform((v) => ['1', 'true', 'yes'].includes(v.trim().toLowerCase())),
  /** Encrypted wallet JSON. Unset uses DATA_DIR/wallet/zcode-bot-wallet.json. */
  WALLET_FILE: z.string().optional(),
  /** Unlocks WALLET_FILE. Never logged. Empty means the arm form must supply it. */
  COPYDESK_WALLET_PASSPHRASE: z.string().default(''),
  /** Required to raise a risk limit from the dashboard. Empty rejects increases. */
  RISK_PIN: z.string().default(''),

  HELIUS_API_KEY: z.string().default(''),
  HELIUS_WEBHOOK_SECRET: z.string().default(''),
  LEADER_POLL_INTERVAL_MS: intervalMs.default(8000),

  // Free public Solana JSON-RPC for the candidate activity refresh (the D4
  // funded-buy screen). Unset = the well-known public endpoint; empty string
  // disables it and the refresh falls back to Helius. The trading monitor never
  // uses this.
  PUBLIC_SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),

  JUPITER_BASE_URL: z.string().url().default('https://api.jup.ag'),
  JUPITER_API_KEY: z.string().default(''),
  /** Helius project id for the Admin usage API. Empty skips reconciliation. */
  HELIUS_PROJECT_ID: z.string().default(''),
  /**
   * Local agent API. Empty disables the routes. The token is not a session
   * cookie and cannot arm, sign, or withdraw.
   */
  AGENT_API_TOKEN: z.string().default(''),
  /** Outbound webhook for an opened seat. Empty disables the post. */
  AGENT_WEBHOOK_URL: z.string().url().optional(),
  /** `auto` fills a free seat from the bench. `agent` waits for a hire decision. */
  HIRE_APPROVAL: z.enum(['auto', 'agent']).default('auto'),

  // Optional FOMO web discovery (read-only browser adapter). Unset = manual import only.
  FOMO_LEADERBOARD_URL: z.string().optional(),
  FOMO_ROBOTS_URL: z.string().optional(),
  FOMO_PROFILE_ADDRESS_SELECTOR: z.string().optional(),
  FOMO_BROWSER_CHANNEL: z.enum(['chrome', 'msedge']).optional(),
  FOMO_SELECTORS_JSON: z.string().optional(),
  FOMO_WEB_POLL_MS: z.coerce.number().int().positive().default(21_600_000),
  /** 'personal-copy': adapter runs on a copy of the desktop Chrome profile (no login ceremony). */
  FOMO_PROFILE_MODE: z.enum(['dedicated', 'personal-copy']).default('personal-copy'),

  // fomoapi.io discovery inlet (D3): the primary handle/wallet source. The key
  // is entered locally in .env and never logged or sent to the dashboard.
  FOMOAPI_KEY: z.string().optional(),
  FOMOAPI_BASE_URL: z.string().url().default('https://api.fomoapi.io'),

  // Optional Dawn (Telegram) trader lookup (read-only browser adapter over the
  // operator's own Telegram Web session). Unset DAWN_BOT_USERNAME = disabled.
  // Resolves fomo handles to the wallet addresses Dawn displays for them.
  DAWN_BOT_USERNAME: z.string().optional(),
  DAWN_WEB_URL: z.string().url().default('https://web.telegram.org/k/'),
  DAWN_BROWSER_CHANNEL: z.enum(['chrome', 'msedge']).optional(),
  // Scheduled Dawn runs moved to the 30-minute data sweep (CLI-driven);
  // DAWN_MAX_LOOKUPS_PER_RUN still caps each run.
  DAWN_MAX_LOOKUPS_PER_RUN: z.coerce.number().int().positive().default(25),

  // Helius activity refresh (day-trader ranking + pre-hire gate alignment).
  ACTIVITY_REFRESH_POLL_MS: z.coerce.number().int().positive().default(21_600_000),
  ACTIVITY_MAX_PER_RUN: z.coerce.number().int().positive().default(30),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  /**
   * Allow the automatic flat-only trader rotation in LIVE mode. Off by default:
   * paper/demo rotate regardless, but an armed live session must opt in
   * explicitly before the engine may swap traders on its own.
   */
  ROTATE_ON_REFRESH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Risk values come through as strings from .env and are merged with defaults.
  RISK_JSON: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  mode: Mode;
  risk: RiskConfig;
}

/** Parse process.env-shaped input into a validated AppConfig. */
export function loadConfig(input: Record<string, string | undefined>): AppConfig {
  const env = envSchema.parse(input);
  let riskOverrides: Record<string, unknown> = {};
  if (env.RISK_JSON && env.RISK_JSON.trim()) {
    try {
      riskOverrides = JSON.parse(env.RISK_JSON) as Record<string, unknown>;
    } catch {
      throw new Error('RISK_JSON is not valid JSON');
    }
  }
  const riskFromEnv: Record<string, string> = {};
  // Enumerate the config keys through DEFAULT_RISK: the schema carries a
  // cross-field refinement, so it is no longer a plain ZodObject with `.shape`.
  for (const key of Object.keys(DEFAULT_RISK)) {
    const raw = input[key];
    if (raw !== undefined && raw !== '') riskFromEnv[key] = raw;
  }
  const merged = { ...riskFromEnv, ...riskOverrides };
  const coerced: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    coerced[k] = typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  const risk = riskConfigSchema.parse({ ...DEFAULT_RISK, ...coerced });
  return { env, mode: env.MODE, risk };
}

export { modeSchema, riskConfigSchema };
export type { Mode, RiskConfig };
