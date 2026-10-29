/**
 * Trader activation state machine and application control states.
 * Transitions are guarded; illegal transitions throw so bugs surface in tests
 * instead of silently corrupting trading state.
 */

export type ActivationState = 'WATCHING' | 'ACTIVE' | 'FIRING' | 'FIRED' | 'REQUIRES_RECONCILIATION';

const ACTIVATION_TRANSITIONS: Record<ActivationState, ActivationState[]> = {
  WATCHING: ['ACTIVE', 'FIRED'],
  ACTIVE: ['FIRING', 'FIRED', 'REQUIRES_RECONCILIATION'],
  FIRING: ['FIRED', 'REQUIRES_RECONCILIATION'],
  FIRED: [],
  REQUIRES_RECONCILIATION: ['FIRED', 'ACTIVE'],
};

export function canTransitionActivation(from: ActivationState, to: ActivationState): boolean {
  return ACTIVATION_TRANSITIONS[from].includes(to);
}

export function transitionActivation(from: ActivationState, to: ActivationState): ActivationState {
  if (!canTransitionActivation(from, to)) {
    throw new Error(`Illegal activation transition ${from} -> ${to}`);
  }
  return to;
}

/**
 * Application-level control state. Distinct dashboard badge states map from
 * these plus mode (DEMO/PAPER/LIVE) and health flags.
 */
export type AppState =
  | 'RUNNING'
  | 'PAUSED_NEW_ENTRIES'
  | 'PAUSED_WAITING_FOR_CANDIDATE'
  | 'PAUSED_WAITING_FOR_ZCODE'
  | 'EMERGENCY_STOPPED'
  | 'REQUIRES_RECONCILIATION';

export type DashboardBadge = 'DEMO' | 'PAPER' | 'LIVE' | 'PAUSED' | 'STALE' | 'RECONCILIATION';

export function dashboardBadges(input: {
  mode: 'demo' | 'paper' | 'live';
  armed: boolean;
  appState: AppState;
  dataStale: boolean;
}): DashboardBadge[] {
  const badges: DashboardBadge[] = [];
  if (input.mode === 'demo') badges.push('DEMO');
  else if (input.mode === 'paper') badges.push('PAPER');
  else if (input.armed) badges.push('LIVE');
  else badges.push('PAPER'); // live mode but not armed must not display LIVE
  if (input.appState.startsWith('PAUSED') || input.appState === 'EMERGENCY_STOPPED') {
    badges.push('PAUSED');
  }
  if (input.dataStale || input.appState === 'REQUIRES_RECONCILIATION') {
    if (input.appState === 'REQUIRES_RECONCILIATION') badges.push('RECONCILIATION');
    else badges.push('STALE');
  }
  return badges;
}
