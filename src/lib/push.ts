/**
 * Web Push plumbing.
 *
 * What this can do: register the service worker, ask the push service for a
 * subscription, and store that subscription so the `send-reminders` job can
 * reach the device while the app is closed.
 *
 * What it cannot do: guarantee delivery, or make the device play a loud alarm.
 * Push is delivered by the browser vendor's push service under the OS's
 * notification rules. See docs/ALARMS_AND_NOTIFICATIONS.md.
 */
import type { DataAdapter } from './data/types';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const SW_URL = `${import.meta.env.BASE_URL}sw.js`;

export type PushStatus =
  | { state: 'unsupported'; reason: string }
  | { state: 'unconfigured'; reason: string }
  | { state: 'denied'; reason: string }
  | { state: 'idle' }
  | { state: 'subscribed'; endpoint: string }
  | { state: 'error'; reason: string };

export function pushSupport(): PushStatus {
  if (typeof window === 'undefined') return { state: 'unsupported', reason: 'No browser context.' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { state: 'unsupported', reason: 'This browser does not support Web Push.' };
  }
  if (!VAPID_PUBLIC_KEY) {
    return {
      state: 'unconfigured',
      reason: 'Web Push is not configured for this deployment (no VAPID public key).',
    };
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return {
      state: 'denied',
      reason: 'Notifications are blocked for this site. Re-enable them in the browser’s site settings.',
    };
  }
  return { state: 'idle' };
}

/** base64url → Uint8Array over a plain ArrayBuffer, as `applicationServerKey` wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: import.meta.env.BASE_URL });
  } catch (error) {
    console.warn('Service worker registration failed:', error);
    return null;
  }
}

/**
 * Subscribe this device and persist the subscription.
 *
 * Only call this from a click handler: browsers require a user gesture before
 * they will show the permission prompt, and asking on page load is exactly the
 * behaviour LunaDesk avoids.
 */
export async function subscribeToPush(
  adapter: DataAdapter,
  userId: string,
): Promise<PushStatus> {
  const support = pushSupport();
  if (support.state !== 'idle') return support;

  const registration = await registerServiceWorker();
  if (!registration) return { state: 'error', reason: 'The service worker could not start.' };

  try {
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
      }));

    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      return { state: 'error', reason: 'The push service returned an incomplete subscription.' };
    }

    // One row per device. Re-subscribing is idempotent thanks to the unique
    // endpoint in the database.
    await adapter.insert('push_subscriptions', {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });

    return { state: 'subscribed', endpoint: json.endpoint };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Subscription failed.';
    return { state: 'error', reason: message };
  }
}

/** Remove this device's subscription. Silent if there was nothing to remove. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
