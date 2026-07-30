export type PermissionState = 'idle' | 'supported' | 'prompting' | 'granted' | 'denied' | 'unavailable';
export type BadgeFallbackState = Readonly<{ badge: 'none' | 'pending'; pendingActivityIds: readonly string[] }>;

/** Browser APIs are injected to keep onboarding testable and framework-neutral. */
export interface PermissionClient {
  isSupported(): boolean;
  permission(): 'default' | 'granted' | 'denied';
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
}

export function initialPermissionState(client: PermissionClient): PermissionState {
  if (!client.isSupported()) return 'unavailable';
  const permission = client.permission();
  return permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'supported';
}

export function beginPermissionRequest(state: PermissionState): PermissionState {
  return state === 'supported' ? 'prompting' : state;
}

export async function requestNotificationPermission(client: PermissionClient): Promise<PermissionState> {
  if (!client.isSupported()) return 'unavailable';
  if (client.permission() === 'denied') return 'denied';
  return (await client.requestPermission()) === 'granted' ? 'granted' : 'denied';
}

/** Persistent-storage adapters can retain this value when browser push is denied/unavailable. */
export function enqueueBadgeFallback(current: BadgeFallbackState, activityId: string): BadgeFallbackState {
  if (current.pendingActivityIds.includes(activityId)) return current;
  return { badge: 'pending', pendingActivityIds: [...current.pendingActivityIds, activityId] };
}

export function clearBadgeFallback(current: BadgeFallbackState, activityId: string): BadgeFallbackState {
  const pendingActivityIds = current.pendingActivityIds.filter((id) => id !== activityId);
  return { badge: pendingActivityIds.length === 0 ? 'none' : 'pending', pendingActivityIds };
}

export const emptyBadgeFallback: BadgeFallbackState = { badge: 'none', pendingActivityIds: [] };
