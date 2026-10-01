/* Web Push from a Worker: VAPID auth (RFC 8292) and aes128gcm payloads (RFC 8291).
 *
 * Only what this app needs — one short JSON payload per notification, one record,
 * no batching. Verified against the RFC 8291 Appendix A test vector.
 */

const enc = new TextEncoder();

export function b64uToBytes(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// One HKDF step: PRK = HMAC(salt, ikm), OKM = HMAC(PRK, info || 0x01)[0..len]
async function hkdf(salt, ikm, info, len) {
  const prkKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, ikm));
  const okmKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', okmKey, concat(info, new Uint8Array([1]))));
  return okm.slice(0, len);
}

// An uncompressed P-256 point (65 bytes) as a JWK, with the private scalar when given.
function pointToJwk(point, d) {
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(point.slice(1, 33)),
    y: bytesToB64u(point.slice(33, 65)),
    ext: true,
  };
  if (d) jwk.d = d;
  return jwk;
}

export async function encryptPayload(payload, p256dhB64u, authB64u, testKeys) {
  const plaintext = typeof payload === 'string' ? enc.encode(payload) : payload;
  const uaPublic = b64uToBytes(p256dhB64u);
  const authSecret = b64uToBytes(authB64u);

  // The sender's key pair is fresh for every message; tests pin it.
  let asPrivate, asPublic;
  if (testKeys) {
    asPublic = b64uToBytes(testKeys.publicKey);
    asPrivate = await crypto.subtle.importKey('jwk', pointToJwk(asPublic, testKeys.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const salt = testKeys ? b64uToBytes(testKeys.salt) : crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await crypto.subtle.importKey('jwk', pointToJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 is the delimiter for the last (only) record.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

// VAPID: a short-lived ES256 JWT saying who is sending and to which push service.
export async function vapidAuth(endpoint, publicKeyB64u, privateKeyB64u, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const signing = enc.encode(header + '.' + body);

  const key = await crypto.subtle.importKey('jwk', pointToJwk(b64uToBytes(publicKeyB64u), privateKeyB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signing));
  return `vapid t=${header}.${body}.${bytesToB64u(sig)}, k=${publicKeyB64u}`;
}

// Returns the push service's status: 201 sent, 404/410 gone (drop the subscription).
export async function sendPush(sub, payload, env) {
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'normal',
      Authorization: await vapidAuth(sub.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT || 'mailto:nobody@example.com'),
    },
    body,
  });
  return res.status;
}
