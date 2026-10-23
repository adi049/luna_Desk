#!/usr/bin/env node
/**
 * Generate the VAPID key pair used for Web Push.
 *
 *   node scripts/generate-vapid-keys.mjs
 *
 * Put the public key in VITE_VAPID_PUBLIC_KEY (frontend) and both keys in the
 * Edge Function secrets (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). The private key
 * must never be committed or shipped to the browser.
 *
 * This uses only Node's built-in crypto — no dependencies.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// Uncompressed point (0x04 || X || Y) is what the Push API expects.
const publicJwk = publicKey.export({ format: 'jwk' });
const point = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(publicJwk.x, 'base64url'),
  Buffer.from(publicJwk.y, 'base64url'),
]);

const privateJwk = privateKey.export({ format: 'jwk' });

console.log(`VITE_VAPID_PUBLIC_KEY=${b64url(point)}
VAPID_PUBLIC_KEY=${b64url(point)}
VAPID_PRIVATE_KEY=${privateJwk.d}
VAPID_SUBJECT=mailto:hello@managedbyluna.com
CRON_SECRET=${b64url(randomBytes(32))}
`);
