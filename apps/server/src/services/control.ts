import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';

/**
 * Runtime control flags. Emergency stop immediately prevents new entries and
 * new non-risk-reducing signing; it cannot recall already-submitted
 * transactions (documented, surfaced in the UI).
 */
export interface ControlFlags {
  newEntriesPaused: boolean;
  emergencyStopped: boolean;
  armed: boolean;
  pausedReason: string | null;
}

export const CONTROL_KEYS = {
  pause: 'control.newEntriesPaused',
  emergency: 'control.emergencyStopped',
  armed: 'control.armed',
  pausedReason: 'control.pausedReason',
} as const;

export class ControlService {
  flags: ControlFlags = {
    newEntriesPaused: false,
    emergencyStopped: false,
    armed: false,
    pausedReason: null,
  };

  /**
   * Set for the duration of a withdrawal broadcast. Never persisted: it exists
   * only to stop a monitor tick from opening a position (and spending the
   * cash being withdrawn) between the balance check and the send.
   */
  withdrawInFlight = false;

  constructor(private db: AppDatabase) {
    this.flags.newEntriesPaused = repo.kvGet(db, CONTROL_KEYS.pause) === '1';
    this.flags.emergencyStopped = repo.kvGet(db, CONTROL_KEYS.emergency) === '1';
    this.flags.armed = repo.kvGet(db, CONTROL_KEYS.armed) === '1';
    this.flags.pausedReason = repo.kvGet(db, CONTROL_KEYS.pausedReason) ?? null;
    // Fail-closed across restarts: arming requires the wallet secret in
    // memory, which never survives a restart — so a boot always disarms and
    // the operator re-arms explicitly (dashboard, secret, ARM LIVE).
    if (this.flags.armed) {
      this.flags.armed = false;
      this.persist();
      repo.controlEvent(db, 'boot_disarm');
      repo.audit(db, 'control', 'boot: armed state cleared — re-arm required after restart');
    }
  }

  private persist(): void {
    repo.kvSet(this.db, CONTROL_KEYS.pause, this.flags.newEntriesPaused ? '1' : '0');
    repo.kvSet(this.db, CONTROL_KEYS.emergency, this.flags.emergencyStopped ? '1' : '0');
    repo.kvSet(this.db, CONTROL_KEYS.armed, this.flags.armed ? '1' : '0');
    repo.kvSet(this.db, CONTROL_KEYS.pausedReason, this.flags.pausedReason ?? '');
  }

  pauseNewEntries(reason: string): void {
    this.flags.newEntriesPaused = true;
    this.flags.pausedReason = reason;
    this.persist();
    repo.controlEvent(this.db, 'pause', reason);
    repo.audit(this.db, 'control', 'new entries paused', { reason });
  }

  resumeNewEntries(): void {
    this.flags.newEntriesPaused = false;
    this.flags.pausedReason = null;
    this.persist();
    repo.controlEvent(this.db, 'resume');
    repo.audit(this.db, 'control', 'new entries resumed');
  }

  emergencyStop(): void {
    this.flags.emergencyStopped = true;
    this.flags.armed = false;
    this.persist();
    repo.controlEvent(this.db, 'emergency_stop', 'new entries blocked; non-risk-reducing signing blocked');
    repo.audit(this.db, 'control', 'EMERGENCY STOP engaged');
  }

  clearEmergency(): void {
    this.flags.emergencyStopped = false;
    this.persist();
    repo.controlEvent(this.db, 'resume', 'emergency stop cleared');
    repo.audit(this.db, 'control', 'emergency stop cleared');
  }

  armLive(): void {
    this.flags.armed = true;
    this.persist();
    repo.controlEvent(this.db, 'arm_live');
    repo.audit(this.db, 'control', 'LIVE MODE ARMED');
  }

  disarm(): void {
    this.flags.armed = false;
    this.persist();
    repo.controlEvent(this.db, 'disarm');
    repo.audit(this.db, 'control', 'live disarmed');
  }

  /** Entries allowed only when everything is healthy and unpaused. */
  entriesAllowed(): boolean {
    return !this.flags.newEntriesPaused && !this.flags.emergencyStopped && !this.withdrawInFlight;
  }

  /** Risk-reducing actions (leader-exit mirrors, fire closes) remain allowed
   * under emergency stop; only new exposure and non-risk-reducing signing are blocked. */
  exitsAllowed(): boolean {
    return true;
  }
}
