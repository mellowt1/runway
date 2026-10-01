/* The bank side of Runway: a PIN, the bank connections, the sync, and the tags.
 *
 * Plan and state stay link-only, as before. Everything here also needs a device key,
 * which a phone gets by entering the PIN once. Four documents per code:
 *
 *   pin:<code>     the PIN's HMAC, failed attempts, and the device keys it has issued
 *   bank:<code>    the connections: bank, consent end, accounts, balances, last sync
 *   banktx:<code>  booked transactions from every connected account, newest first
 *   tags:<code>    what the people changed: a payment moved to another bucket, marked
 *                  as not spending, hidden, or flagged; payee rules ("always"); and
 *                  which account is the pocket for which everyday budget (acct)
 *
 * The bank is the record: nothing here edits an amount or a date. Pending movements
 * are left out until they book. Money moved between two connected accounts (same
 * amount, opposite direction, within a day) is marked `own` so it is not spending.
 *
 *   POST   /api/pin/:code              <- { pin, by }     set the first PIN, or change it (with a key)
 *   POST   /api/unlock/:code           <- { pin, by }     -> { key } | 403 { left } | 423 { until }
 *   POST   /api/lock/:code                                forget this device's key
 *   DELETE /api/pin/:code                                 admin token: clear the PIN and every key
 *   GET    /api/bank/:code                                -> { conns, synced, tx, tags }
 *   GET    /api/bank/:code/banks?country=NL               -> { banks: [{ name, country, days }] }
 *   POST   /api/bank/:code/connect     <- { name, country, by } -> { url }   the bank's own login page
 *   GET    /api/bank/callback                             the bank sends the browser back here
 *   POST   /api/bank/:code/sync                           sync now (at most every ten minutes)
 *   POST   /api/bank/:code/disconnect  <- { conn }        ends the consent at the bank too
 *   POST   /api/tag/:code              <- { by, id, b, ns, hide, flag } | { by, payee, b } | { by, acct, pocket }
 *
 * The bank routes need header X-Runway-Key. A cron syncs every code four times a day,
 * the most banks allow without the person present.
 */

import * as eb from './eb.js';

const TTL = 400 * 24 * 3600;
const KEEP_DAYS = 400;
const MAX_TX = 3000;
const FIRST_DAYS = 90;
const OVERLAP_DAYS = 7;
const MAX_PAGES = 30;
const SYNC_COOLDOWN = 10 * 60 * 1000;
const PIN_TRIES = 5;
const PIN_LOCK = 24 * 3600 * 1000;
const MAX_KEYS = 12;
const BUCKETS = new Set(['bills', 'everyday', 'debt', 'oneoff']);
const BALANCE_PREF = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD', 'OPAV', 'PRCD', 'OTHR'];
const APP = 'https://mellowt1.github.io/runway/';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rand = (n = 32) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const clean = (v, n) =>
  String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function read(env, key) {
  const raw = await env.RUNWAY_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
const write = (env, key, doc) => env.RUNWAY_KV.put(key, JSON.stringify(doc), { expirationTtl: TTL });

// ---------------------------------------------------------------- PIN and keys

// HMAC keyed with the admin token, so a copy of KV alone cannot be used to try
// every four-digit PIN offline. Changing ADMIN_TOKEN therefore resets the PIN.
async function pinHash(env, code, salt, pin) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.ADMIN_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`pin|${code}|${salt}|${pin}`)));
}

const validPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);

async function issueKey(env, code, rec, by) {
  const key = rand();
  rec.keys = [...(rec.keys || []), { h: await sha(key), by: by || null, at: new Date().toISOString() }].slice(
    -MAX_KEYS
  );
  return key;
}

// The key a phone sends. Returns the pin doc when it matches one issued for this code.
async function checkKey(env, code, request) {
  const key = request.headers.get('X-Runway-Key') || '';
  if (!key || key.length > 64) return null;
  const rec = await read(env, `pin:${code}`);
  if (!rec || !Array.isArray(rec.keys)) return null;
  const h = await sha(key);
  return rec.keys.some((k) => k.h === h) ? rec : null;
}

async function handlePin(request, env, code, json) {
  if (!env.ADMIN_TOKEN) return json({ error: 'not configured' }, 500);
  const pinKey = `pin:${code}`;

  if (request.method === 'DELETE') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (token !== env.ADMIN_TOKEN) return json({ error: 'admin token required' }, 401);
    await env.RUNWAY_KV.delete(pinKey);
    return json({ ok: true });
  }

  const body = await request.json().catch(() => null);
  const pin = body && body.pin;
  if (!validPin(pin)) return json({ error: 'pin is 4 to 8 digits' }, 400);
  const by = clean(body.by, 24);
  const prev = await read(env, pinKey);
  if (prev && prev.hash && !(await checkKey(env, code, request))) {
    return json({ error: 'a pin is already set' }, 409);
  }
  // A changed PIN signs every other phone out.
  const rec = { salt: rand(12), fails: 0, keys: [] };
  rec.hash = await pinHash(env, code, rec.salt, pin);
  const key = await issueKey(env, code, rec, by);
  await write(env, pinKey, rec);
  return json({ ok: true, key });
}

async function handleUnlock(request, env, code, json) {
  if (!env.ADMIN_TOKEN) return json({ error: 'not configured' }, 500);
  // A second, per-code limit that does not depend on KV being consistent between
  // two quick requests. Optional: without the binding the fail counter still holds.
  if (env.PIN_LIMITER) {
    const { success } = await env.PIN_LIMITER.limit({ key: code });
    if (!success) return json({ error: 'too many tries, wait a minute' }, 429);
  }
  const body = await request.json().catch(() => null);
  const pin = body && body.pin;
  const rec = await read(env, `pin:${code}`);
  if (!rec || !rec.hash) return json({ error: 'no pin set', nopin: true }, 404);
  const now = Date.now();
  if (rec.until && rec.until > now) return json({ error: 'locked', until: new Date(rec.until).toISOString() }, 423);
  if (!validPin(pin) || (await pinHash(env, code, rec.salt, pin)) !== rec.hash) {
    rec.fails = (rec.until && rec.until <= now ? 0 : rec.fails || 0) + 1;
    delete rec.until;
    if (rec.fails >= PIN_TRIES) {
      rec.until = now + PIN_LOCK;
      rec.fails = 0;
      await write(env, `pin:${code}`, rec);
      return json({ error: 'locked', until: new Date(rec.until).toISOString() }, 423);
    }
    await write(env, `pin:${code}`, rec);
    return json({ error: 'wrong pin', left: PIN_TRIES - rec.fails }, 403);
  }
  rec.fails = 0;
  delete rec.until;
  const key = await issueKey(env, code, rec, clean(body.by, 24));
  await write(env, `pin:${code}`, rec);
  return json({ ok: true, key });
}

async function handleLock(request, env, code, json) {
  const rec = await checkKey(env, code, request);
  if (!rec) return json({ ok: true });
  const h = await sha(request.headers.get('X-Runway-Key'));
  rec.keys = rec.keys.filter((k) => k.h !== h);
  await write(env, `pin:${code}`, rec);
  return json({ ok: true });
}

// ---------------------------------------------------------------- transactions

// Identity for a movement, so a re-fetched window does not land twice. Same order as
// the other project: entry_reference, transaction_id, then a hash of the fields that
// identify it. Never fuzzy on amount and payee alone: two coffees are two coffees.
function dedupKey(tx) {
  if (tx.entry_reference) return `ref:${tx.entry_reference}`;
  if (tx.transaction_id) return `txid:${tx.transaction_id}`;
  return [
    'h',
    tx.transaction_date || tx.value_date || tx.booking_date || '',
    tx.transaction_amount && tx.transaction_amount.amount,
    tx.transaction_amount && tx.transaction_amount.currency,
    tx.credit_debit_indicator || '',
    (tx.creditor && tx.creditor.name) || (tx.debtor && tx.debtor.name) || '',
    (tx.remittance_information || []).join(' '),
  ].join('|');
}

// On a debit the person paid the creditor; on a credit the debtor paid them.
function counterparty(tx) {
  const c = tx.creditor && tx.creditor.name;
  const d = tx.debtor && tx.debtor.name;
  return tx.credit_debit_indicator === 'CRDT' ? d || c || '' : c || d || '';
}

export async function toTx(k, tx) {
  const a = tx.transaction_amount || {};
  if (a.currency && a.currency !== 'EUR') return null;
  if (tx.status && tx.status !== 'BOOK') return null;
  const n = Number(a.amount);
  if (!Number.isFinite(n) || n === 0) return null;
  const sign =
    tx.credit_debit_indicator === 'CRDT' ? 1 : tx.credit_debit_indicator === 'DBIT' ? -1 : n < 0 ? -1 : 1;
  const d = tx.booking_date || tx.value_date || tx.transaction_date;
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const out = {
    id: (await sha(`${k}|${dedupKey(tx)}`)).slice(0, 16),
    k,
    d: d.slice(0, 10),
    amt: sign * Math.round(Math.abs(n) * 100) / 100,
    who: clean(counterparty(tx), 60),
  };
  const desc = clean((tx.remittance_information || []).join(' '), 140);
  if (desc && desc !== out.who) out.desc = desc;
  if (tx.merchant_category_code) out.mcc = clean(tx.merchant_category_code, 4);
  return out;
}

// Pairs a debit on one connected account with a credit of the same amount on another
// within a day. Both legs stay listed; `own` keeps them out of every total.
export function markOwnTransfers(list) {
  const dayMs = 86400000;
  const open = list.filter((t) => !t.own);
  const credits = open.filter((t) => t.amt > 0);
  for (const out of open) {
    if (out.amt >= 0 || out.own) continue;
    const cents = Math.round(-out.amt * 100);
    const t0 = Date.parse(out.d);
    const match = credits.find(
      (c) => !c.own && c.k !== out.k && Math.round(c.amt * 100) === cents && Math.abs(Date.parse(c.d) - t0) <= dayMs
    );
    if (match) {
      out.own = 1;
      match.own = 1;
    }
  }
}

function pickBalance(balances) {
  const eur = (balances || []).filter((b) => b.balance_amount && (b.balance_amount.currency || 'EUR') === 'EUR');
  for (const type of BALANCE_PREF) {
    const b = eur.find((x) => x.balance_type === type);
    if (b) return { amt: Number(b.balance_amount.amount), type };
  }
  return eur[0] ? { amt: Number(eur[0].balance_amount.amount), type: eur[0].balance_type || null } : null;
}

async function fetchAll(env, uid, dateFrom, psu) {
  const all = [];
  let cont;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await eb.getTransactions(env, uid, { date_from: dateFrom, continuation_key: cont }, psu);
    if (!r.ok) return r;
    all.push(...(r.data.transactions || []));
    cont = r.data.continuation_key;
    if (!cont) break;
  }
  return { ok: true, data: all };
}

// One pass over every connection for a code. An account that fails keeps its last
// balance and says why; the others still update.
export async function syncCode(env, code, { psu } = {}) {
  const metaKey = `bank:${code}`;
  const meta = await read(env, metaKey);
  if (!meta || !Array.isArray(meta.conns) || !meta.conns.length) return { ok: false, reason: 'no connections' };
  const txDoc = (await read(env, `banktx:${code}`)) || { list: [], rev: 0 };
  const byId = new Map((txDoc.list || []).map((t) => [t.id, t]));
  const now = new Date().toISOString();
  let added = 0;
  const errors = [];

  for (const conn of meta.conns) {
    if (conn.until && Date.parse(conn.until) < Date.now()) {
      conn.status = 'expired';
      continue;
    }
    if (conn.status === 'expired') continue;
    let failed = null;
    for (const acct of conn.accounts || []) {
      if (acct.cur && acct.cur !== 'EUR') continue;
      const bal = await eb.getBalances(env, acct.uid, psu);
      if (!bal.ok) {
        failed = bal;
        break;
      }
      const b = pickBalance(bal.data.balances);
      if (b && Number.isFinite(b.amt)) Object.assign(acct, { bal: b.amt, balType: b.type, balAt: now });

      const from = acct.synced ? addDays(acct.synced.slice(0, 10), -OVERLAP_DAYS) : addDays(today(), -FIRST_DAYS);
      const txs = await fetchAll(env, acct.uid, from, psu);
      if (!txs.ok) {
        failed = txs;
        break;
      }
      for (const raw of txs.data) {
        const t = await toTx(acct.k, raw);
        if (!t) continue;
        const prev = byId.get(t.id);
        if (prev) {
          if (prev.own) t.own = prev.own;
          byId.set(t.id, t);
        } else {
          byId.set(t.id, t);
          added++;
        }
      }
      acct.synced = now;
    }
    if (failed) {
      conn.status = failed.kind === 'consent_expired' ? 'expired' : 'error';
      conn.err = failed.kind;
      errors.push({ bank: conn.bank, kind: failed.kind, detail: failed.detail });
    } else {
      conn.status = 'ok';
      delete conn.err;
      conn.synced = now;
    }
  }

  const floor = addDays(today(), -KEEP_DAYS);
  let list = [...byId.values()].filter((t) => t.d >= floor);
  list.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  list = list.slice(0, MAX_TX);
  markOwnTransfers(list);

  meta.synced = now;
  meta.rev = (meta.rev || 0) + 1;
  await write(env, `banktx:${code}`, { list, rev: (txDoc.rev || 0) + 1 });
  await write(env, metaKey, meta);
  return { ok: !errors.length, added, errors };
}

export async function syncAll(env) {
  let cursor;
  do {
    const page = await env.RUNWAY_KV.list({ prefix: 'bank:', cursor });
    for (const k of page.keys) {
      const code = k.name.slice(5);
      try {
        await syncCode(env, code);
      } catch (e) {
        console.log('sync failed', code, e && e.message);
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// ---------------------------------------------------------------- connections

// What a phone may see: no session ids, no account uids.
function publicMeta(meta) {
  if (!meta) return { conns: [], synced: null, rev: 0 };
  return {
    conns: (meta.conns || []).map((c) => ({
      id: c.id,
      bank: c.bank,
      country: c.country,
      until: c.until || null,
      status: c.status || 'ok',
      err: c.err || null,
      synced: c.synced || null,
      accounts: (c.accounts || []).map((a) => ({
        k: a.k,
        name: a.name,
        iban4: a.iban4 || null,
        cur: a.cur || null,
        bal: a.bal ?? null,
        balType: a.balType || null,
        balAt: a.balAt || null,
      })),
    })),
    synced: meta.synced || null,
    rev: meta.rev || 0,
  };
}

export async function bankSummary(env, code) {
  const [pin, meta, tags] = await Promise.all([
    read(env, `pin:${code}`),
    read(env, `bank:${code}`),
    read(env, `tags:${code}`),
  ]);
  return {
    pin: !!(pin && pin.hash),
    conns: meta && meta.conns ? meta.conns.length : 0,
    rev: ((meta && meta.rev) || 0) + ((tags && tags.rev) || 0),
  };
}

const psuOf = (request) => ({
  ip: request.headers.get('CF-Connecting-IP') || undefined,
  ua: (request.headers.get('User-Agent') || '').slice(0, 200) || undefined,
});

function redirectUrl(env, request) {
  return env.EB_REDIRECT || `${new URL(request.url).origin}/api/bank/callback`;
}

async function handleConnect(request, env, code, json) {
  const body = await request.json().catch(() => null);
  const name = clean(body && body.name, 60);
  const country = clean(body && body.country, 2).toUpperCase();
  if (!name || !/^[A-Z]{2}$/.test(country)) return json({ error: 'name and country required' }, 400);

  // The bank's own ceiling on consent length wins; asking for more gets /auth refused.
  let seconds = 90 * 86400;
  const list = await eb.listAspsps(env, country);
  if (!list.ok) return json({ error: list.kind, detail: list.detail }, 502);
  const aspsp = (list.data.aspsps || []).find((a) => a.name === name);
  if (!aspsp) return json({ error: 'bank not found', country }, 404);
  if (aspsp.maximum_consent_validity) seconds = Math.min(aspsp.maximum_consent_validity, 180 * 86400);

  const state = rand();
  await env.RUNWAY_KV.put(
    `bankauth:${await sha(state)}`,
    JSON.stringify({ code, name, country, by: clean(body.by, 24) }),
    { expirationTtl: 1800 }
  );
  const r = await eb.startAuth(env, {
    aspsp: { name, country },
    redirectUrl: redirectUrl(env, request),
    state,
    seconds,
  });
  if (!r.ok) return json({ error: r.kind, detail: r.detail }, 502);
  return json({ ok: true, url: r.data.url });
}

async function handleCallback(request, env, ctx) {
  const url = new URL(request.url);
  const app = env.APP_URL || APP;
  const back = (code, result) => {
    const u = new URL(app);
    if (code) u.searchParams.set('c', code);
    u.searchParams.set('bank', result);
    return Response.redirect(u.toString(), 302);
  };
  const state = url.searchParams.get('state') || '';
  if (!state || state.length > 64) return back(null, 'fail');
  const authKey = `bankauth:${await sha(state)}`;
  const auth = await read(env, authKey);
  if (!auth) return back(null, 'expired');
  // Single use, whatever happens next.
  await env.RUNWAY_KV.delete(authKey);

  const bankCode = url.searchParams.get('code');
  if (!bankCode) return back(auth.code, url.searchParams.get('error') === 'access_denied' ? 'cancel' : 'fail');

  const s = await eb.createSession(env, bankCode);
  if (!s.ok) return back(auth.code, 'fail');

  const accounts = [];
  for (const a of s.data.accounts || []) {
    const iban = (a.account_id && a.account_id.iban) || '';
    accounts.push({
      uid: a.uid,
      k: (await sha(iban ? `iban|${iban}` : `${auth.name}|${a.uid}`)).slice(0, 10),
      name: clean(a.name || a.product || auth.name, 40),
      iban4: iban ? iban.slice(-4) : null,
      cur: a.currency || null,
    });
  }

  const metaKey = `bank:${auth.code}`;
  const meta = (await read(env, metaKey)) || { conns: [], rev: 0 };
  // Reconnecting a bank replaces its old consent rather than adding a second one.
  const old = meta.conns.filter((c) => c.bank === auth.name && c.country === auth.country);
  meta.conns = meta.conns.filter((c) => !(c.bank === auth.name && c.country === auth.country));
  // Carry each account's sync point over, so a reconnect does not refetch 90 days.
  const oldAccts = new Map(old.flatMap((c) => c.accounts || []).map((a) => [a.k, a]));
  for (const a of accounts) {
    const o = oldAccts.get(a.k);
    if (o) Object.assign(a, { synced: o.synced, bal: o.bal, balType: o.balType, balAt: o.balAt });
  }
  meta.conns.push({
    id: rand(6),
    sid: s.data.session_id,
    bank: auth.name,
    country: auth.country,
    until: (s.data.access && s.data.access.valid_until) || null,
    status: 'ok',
    by: auth.by || null,
    at: new Date().toISOString(),
    accounts,
  });
  meta.rev = (meta.rev || 0) + 1;
  await write(env, metaKey, meta);

  const psu = psuOf(request);
  ctx.waitUntil(
    (async () => {
      for (const o of old) await eb.deleteSession(env, o.sid);
      await syncCode(env, auth.code, { psu });
    })()
  );
  return back(auth.code, 'ok');
}

async function handleSync(request, env, code, json) {
  const meta = await read(env, `bank:${code}`);
  if (!meta || !meta.conns || !meta.conns.length) return json({ error: 'no connections' }, 404);
  if (meta.synced && Date.now() - Date.parse(meta.synced) < SYNC_COOLDOWN) {
    return json({ ok: true, skipped: true, synced: meta.synced });
  }
  const r = await syncCode(env, code, { psu: psuOf(request) });
  return json(r);
}

async function handleDisconnect(request, env, code, json) {
  const body = await request.json().catch(() => null);
  const id = body && body.conn;
  const metaKey = `bank:${code}`;
  const meta = await read(env, metaKey);
  const conn = meta && (meta.conns || []).find((c) => c.id === id);
  if (!conn) return json({ error: 'no such connection' }, 404);
  await eb.deleteSession(env, conn.sid);
  meta.conns = meta.conns.filter((c) => c.id !== id);
  meta.rev = (meta.rev || 0) + 1;
  // Its transactions go too: a disconnected bank should not keep feeding the totals.
  const keys = new Set((conn.accounts || []).map((a) => a.k));
  const tx = (await read(env, `banktx:${code}`)) || { list: [], rev: 0 };
  tx.list = (tx.list || []).filter((t) => !keys.has(t.k));
  tx.rev = (tx.rev || 0) + 1;
  await write(env, `banktx:${code}`, tx);
  if (meta.conns.length) await write(env, metaKey, meta);
  else await env.RUNWAY_KV.delete(metaKey);
  return json({ ok: true });
}

// ---------------------------------------------------------------- tags

// A payee as a rule key: lower case, digits and punctuation gone, first three words,
// so "ALBERT HEIJN 1234 AMSTERDAM" and "Albert Heijn 5678" are one payee. The page
// uses the same function; they must stay identical.
export function payeeKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

async function handleTag(request, env, code, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'body required' }, 400);
  const by = clean(body.by, 24) || null;
  const at = new Date().toISOString();
  const key = `tags:${code}`;
  const doc = (await read(env, key)) || { pay: {}, payee: {}, rev: 0 };
  doc.pay = doc.pay || {};
  doc.payee = doc.payee || {};
  doc.acct = doc.acct || {};

  if (typeof body.acct === 'string') {
    // An account key (from publicMeta) and the plan's flex id it holds the money for.
    if (!/^[0-9a-f]{10}$/.test(body.acct)) return json({ error: 'bad account' }, 400);
    if (body.pocket === null) delete doc.acct[body.acct];
    else if (typeof body.pocket === 'string' && /^[a-z0-9]{1,16}$/.test(body.pocket)) {
      // One account per budget: linking a budget elsewhere unlinks it here.
      for (const k of Object.keys(doc.acct)) if (doc.acct[k].p === body.pocket) delete doc.acct[k];
      doc.acct[body.acct] = { p: body.pocket, by, at };
    } else return json({ error: 'bad pocket' }, 400);
  } else if (typeof body.payee === 'string') {
    const p = payeeKey(body.payee);
    if (!p) return json({ error: 'payee required' }, 400);
    if (body.b === null) delete doc.payee[p];
    else if (BUCKETS.has(body.b)) doc.payee[p] = { b: body.b, by, at };
    else return json({ error: 'bad bucket' }, 400);
  } else if (typeof body.id === 'string' && /^[0-9a-f]{16}$/.test(body.id)) {
    const cur = { ...(doc.pay[body.id] || {}) };
    if ('b' in body) {
      if (body.b === null) delete cur.b;
      else if (BUCKETS.has(body.b)) cur.b = body.b;
      else return json({ error: 'bad bucket' }, 400);
    }
    for (const f of ['ns', 'hide', 'flag']) {
      if (f in body) {
        if (body[f]) cur[f] = 1;
        else delete cur[f];
      }
    }
    delete cur.by;
    delete cur.at;
    if (Object.keys(cur).length) doc.pay[body.id] = { ...cur, by, at };
    else delete doc.pay[body.id];
  } else {
    return json({ error: 'id or payee required' }, 400);
  }
  if (Object.keys(doc.pay).length > 4000) return json({ error: 'too many tags' }, 413);
  doc.rev = (doc.rev || 0) + 1;
  await write(env, key, doc);
  return json({ ok: true, rev: doc.rev });
}

// ---------------------------------------------------------------- routes

export async function bankRoutes(request, env, ctx, url, json) {
  const path = url.pathname;
  const CODE = /^[a-z0-9]{6,16}$/;
  const codeOf = (m) => {
    const c = m[1].toLowerCase();
    return CODE.test(c) ? c : null;
  };
  let m;

  if (path === '/api/bank/callback' && request.method === 'GET') return handleCallback(request, env, ctx);

  if ((m = path.match(/^\/api\/pin\/([a-z0-9]+)$/i))) {
    const code = codeOf(m);
    if (!code) return json({ error: 'bad code' }, 400);
    if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'method' }, 405);
    return handlePin(request, env, code, json);
  }
  if ((m = path.match(/^\/api\/unlock\/([a-z0-9]+)$/i)) && request.method === 'POST') {
    const code = codeOf(m);
    if (!code) return json({ error: 'bad code' }, 400);
    return handleUnlock(request, env, code, json);
  }
  if ((m = path.match(/^\/api\/lock\/([a-z0-9]+)$/i)) && request.method === 'POST') {
    const code = codeOf(m);
    if (!code) return json({ error: 'bad code' }, 400);
    return handleLock(request, env, code, json);
  }

  const bank = path.match(/^\/api\/bank\/([a-z0-9]+)(?:\/(banks|connect|sync|disconnect))?$/i);
  const tag = path.match(/^\/api\/tag\/([a-z0-9]+)$/i);
  if (!bank && !tag) return null;
  const code = codeOf(bank || tag);
  if (!code) return json({ error: 'bad code' }, 400);
  if (!(await checkKey(env, code, request))) return json({ error: 'locked', locked: true }, 401);

  if (tag) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    return handleTag(request, env, code, json);
  }
  const action = bank[2];
  if (!action && request.method === 'GET') {
    const [meta, tx, tags] = await Promise.all([
      read(env, `bank:${code}`),
      env.RUNWAY_KV.get(`banktx:${code}`),
      env.RUNWAY_KV.get(`tags:${code}`),
    ]);
    // The transaction list goes out as stored text, unparsed: it is the big one.
    const pm = publicMeta(meta);
    const body = `{"conns":${JSON.stringify(pm.conns)},"synced":${JSON.stringify(pm.synced)},"rev":${pm.rev},"tx":${
      tx || '{"list":[],"rev":0}'
    },"tags":${tags || '{"pay":{},"payee":{},"rev":0}'}}`;
    return json.raw(body);
  }
  if (action === 'banks' && request.method === 'GET') {
    const country = (url.searchParams.get('country') || 'NL').toUpperCase().slice(0, 2);
    const r = await eb.listAspsps(env, country);
    if (!r.ok) return json({ error: r.kind, detail: r.detail }, 502);
    return json({
      banks: (r.data.aspsps || []).map((a) => ({
        name: a.name,
        country: a.country,
        days: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : null,
      })),
    });
  }
  if (action === 'connect' && request.method === 'POST') return handleConnect(request, env, code, json);
  if (action === 'sync' && request.method === 'POST') return handleSync(request, env, code, json);
  if (action === 'disconnect' && request.method === 'POST') return handleDisconnect(request, env, code, json);
  return json({ error: 'method' }, 405);
}
