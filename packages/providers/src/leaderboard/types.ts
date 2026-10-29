/** Normalized leaderboard entry shared by manual import and web discovery. */
export interface LeaderboardEntry {
  handle: string;
  weeklyRank: number | null;
  /** Displayed (unverified) weekly PnL in USD. */
  displayedPnlUsd: number | null;
  profileUrl: string | null;
  avatarUrl: string | null;
  /** Public Solana leader addresses discovered on the page. */
  solanaAddresses: string[];
  enabled: boolean;
  observedAt: string;
}

export interface LeaderboardImportResult {
  entries: LeaderboardEntry[];
  importId: string;
  warnings: string[];
  /** Handles skipped with reasons (duplicates handled explicitly). */
  skipped: Array<{ handle: string; reason: string }>;
}

export interface LeaderboardProvider {
  readonly name: string;
  /** Whether this provider can currently run (creds/browser present). */
  available(): Promise<boolean>;
  fetchLatest(): Promise<LeaderboardImportResult>;
}
