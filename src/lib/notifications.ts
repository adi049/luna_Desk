/**
 * Browser notification helpers.
 * Permission is only requested from an explicit user gesture (a button), never
 * on page load, and we never re-prompt after a denial — the UI explains how to
 * re-enable it in the browser instead.
 */
export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationSupport(): PermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as PermissionState;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as PermissionState;
  try {
    const result = await Notification.requestPermission();
    return result as PermissionState;
  } catch {
    return 'denied';
  }
}

export function showNotification(title: string, options: NotificationOptions = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      icon: `${import.meta.env.BASE_URL}favicon.svg`,
      badge: `${import.meta.env.BASE_URL}favicon.svg`,
      tag: options.tag ?? 'lunadesk',
      ...options,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* Some browsers (notably mobile Safari) only allow notifications from a
       service worker; silently skip rather than throw into the UI. */
  }
}
