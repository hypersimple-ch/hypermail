export type InstallState = 'unsupported' | 'available' | 'prompting' | 'installed';
export type UpdateState = 'idle' | 'available' | 'activating';

export type PwaState = Readonly<{ install: InstallState; update: UpdateState }>;

export const initialPwaState: PwaState = { install: 'unsupported', update: 'idle' };

/** Host UI calls this after the browser fires beforeinstallprompt. */
export function installAvailable(state: PwaState): PwaState {
  return state.install === 'installed' ? state : { ...state, install: 'available' };
}

export function installPrompting(state: PwaState): PwaState {
  return state.install === 'available' ? { ...state, install: 'prompting' } : state;
}

export function installed(state: PwaState): PwaState {
  return { ...state, install: 'installed' };
}

/** A waiting worker is surfaced; it is never activated without an explicit user action. */
export function updateAvailable(state: PwaState): PwaState {
  return state.update === 'activating' ? state : { ...state, update: 'available' };
}

export function updateActivating(state: PwaState): PwaState {
  return state.update === 'available' ? { ...state, update: 'activating' } : state;
}

export interface MotionPreferenceClient {
  prefersReducedMotion(): boolean;
}

export function prefersReducedMotion(client: MotionPreferenceClient): boolean {
  return client.prefersReducedMotion();
}

export const androidInstallGuidance = 'In Chrome on Android, open the browser menu and choose Install app. Notification permission is requested only after an explicit in-app action.';
export const updateGuidance = 'A new version is ready. Reload to update; the current version remains active until then.';
