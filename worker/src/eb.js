/* Enable Banking transport: the JWT and the AIS calls, nothing else.
 *
 * A port of the owner's other project (enableBankingClient.ts) from node:crypto to
 * WebCrypto, so it runs in a Worker. It knows nothing about Runway: which accounts,
 * which transactions, what they mean all live in bank.js.
 *
 * ACCOUNT INFORMATION ONLY. Enable Banking can also start payments; there is
 * deliberately no wrapper for that here. This app reads a bank, it never moves money.
 *
 * Secrets: EB_APP_ID (the application id from the Enable Banking Control Panel) and
 * EB_PRIVATE_KEY (the PEM it gave you, PKCS#8 or PKCS#1). EB_BASE overrides the API
 * host, which only the local tests use.
 */

const JWT_TTL = 3600;
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

// WebCrypto only imports PKCS#8. A key saved as "BEGIN RSA PRIVATE KEY" is PKCS#1,
// so it is wrapped: SEQUENCE { INTEGER 0, rsaEncryption, OCTET STRING <pkcs1> }.
export function pemToPkcs8(pem) {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pkcs1) return raw;
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const ver = [0x02, 0x01, 0x00];
  const oct = [0x04, ...derLen(raw.length)];
  const inner = ver.length + alg.length + oct.length + raw.length;
  const out = new Uint8Array([0x30, ...derLen(inner), ...ver, ...alg, ...oct, ...raw]);
  return out;
}

let cached = null;
async function signingKey(env) {
  if (cached && cached.pem === env.EB_PRIVATE_KEY) return cached.key;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.EB_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cached = { pem: env.EB_PRIVATE_KEY, key };
  return key;
}

// iss/aud are fixed strings their API wants verbatim; kid is the application id.
export async function buildJwt(appId, key, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId })));
  const claims = b64url(
    enc.encode(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + JWT_TTL }))
  );
  const input = `${head}.${claims}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

// Failure kinds stay apart because each has a different fix: consent_expired means
// "connect the bank again", rate_limited means "wait", application_inactive means the
// app in the Control Panel has no linked accounts yet (it arrives as a plain 403,
// told apart from a bad key only by the message).
export function classifyStatus(status, detail) {
  if ((status === 401 || status === 403) && /not active|inactive/i.test(detail)) {
    return { kind: 'application_inactive', status, detail };
  }
  if (status === 401 || status === 403) return { kind: 'unauthorized', status, detail };
  if (status === 429) return { kind: 'rate_limited', status, detail };
  if (status === 422 || status === 451) return { kind: 'consent_expired', status, detail };
  return { kind: 'bad_response', status, detail };
}

// `psu` carries the person's IP and user agent when they are on the page. Sent as
// Psu-* headers, it tells the bank the person is present, which keeps the fetch out
// of the four-a-day budget banks allow for background reads.
export async function ebRequest(env, path, { method = 'GET', body, query, psu } = {}) {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) {
    return { ok: false, kind: 'unconfigured', detail: 'EB_APP_ID and EB_PRIVATE_KEY are not set on the Worker.' };
  }
  let jwt;
  try {
    // Trimmed: a secret piped in from a shell can arrive with a trailing newline,
    // and a kid with a line break on the end is refused as unauthorized.
    jwt = await buildJwt(String(env.EB_APP_ID).trim(), await signingKey(env));
  } catch (e) {
    return { ok: false, kind: 'unconfigured', detail: `EB_PRIVATE_KEY did not load: ${e.message}` };
  }
  const url = new URL((env.EB_BASE || 'https://api.enablebanking.com') + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const headers = { Authorization: `Bearer ${jwt}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (psu && psu.ip) headers['Psu-Ip-Address'] = psu.ip;
  if (psu && psu.ua) headers['Psu-User-Agent'] = psu.ua;

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    // No retry: the next sync tries again, and a retry here would spend the bank's
    // daily budget on a bad connection.
    return { ok: false, kind: 'network', detail: e.message || String(e) };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, ...classifyStatus(res.status, text.slice(0, 400)) };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, kind: 'bad_response', status: res.status, detail: `Expected JSON: ${text.slice(0, 120)}` };
  }
}

export const listAspsps = (env, country) => ebRequest(env, '/aspsps', { query: { country, psu_type: 'personal' } });

// valid_until at second precision: an ASPSP that parses strictly rejects the
// milliseconds of toISOString() with a bare invalid_request, after /auth said 200.
export function startAuth(env, { aspsp, redirectUrl, state, seconds }) {
  const validUntil = new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return ebRequest(env, '/auth', {
    method: 'POST',
    body: {
      access: { valid_until: validUntil },
      aspsp,
      state,
      redirect_url: redirectUrl,
      psu_type: 'personal',
    },
  });
}

export const createSession = (env, code) => ebRequest(env, '/sessions', { method: 'POST', body: { code } });
export const deleteSession = (env, id) =>
  ebRequest(env, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getBalances = (env, uid, psu) =>
  ebRequest(env, `/accounts/${encodeURIComponent(uid)}/balances`, { psu });
export const getTransactions = (env, uid, query, psu) =>
  ebRequest(env, `/accounts/${encodeURIComponent(uid)}/transactions`, { query, psu });
