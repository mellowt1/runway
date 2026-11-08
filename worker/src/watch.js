/* The bills watch: the alerts that need the bank, sent from the Worker so they reach
 * a phone that is closed.
 *
 * The page knows the plan's bills and learns from the payments when each one usually
 * goes out and from which account. It sends that here; every sync then checks the
 * fresh balances and payments for:
 *
 *   - a direct debit that came back: the same amount booked back onto the same
 *     account within two weeks, from the same payee (or with storno words)
 *   - an account holding less than the bills due from it in the next three days
 *   - a pocket not topped up by the 2nd
 *
 * Each alert goes out once, to every phone that asked for alerts, never between 22:00
 * and 07:00 in the Netherlands (it waits for the next sync).
 *
 *   POST /api/watch/:code  <- { by, m, bills:[{ n, t, a, d, k, o }], pockets:[{ k, n, b }] }
 *                             (device key required, routed from bank.js)
 *
 *   watch:<code>  { m, bills, pockets, by, at, sent:{ alertKey: 'YYYY-MM-DD' } }
 *
 *   bills: n name, t payee words, a amount, d usual day of the month, k account key,
 *          o 1 for a one-off that belongs to month m only
 *   pockets: k account key, n budget name, b this month's budget
 *
 * The page applies the same rules on screen; keep the two in step.
 */

import { notify } from './alerts.js';

const TTL = 400 * 24 * 3600;
const SOON_DAYS = 3;
const BOUNCE_DAYS = 14;
const STORNO =
  /(^| )(storno|stornering|terugboeking|teruggeboekt|teruggestort|retour|reversal|reversed|returned|rejected|geweigerd|onvoldoende saldo)( |$)/;

const clean = (v, n) =>
  String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const r2 = (v) => Math.round(v * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const gap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

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

// Same as the page's normText / payeeKey.
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
const payeeKey = (s) => normText(s).slice(0, 3).join(' ');
const payeeOf = (t) => t.who || t.desc || '';
const hay = (t) => ' ' + normText(`${t.who || ''} ${t.desc || ''}`).join(' ') + ' ';
const hits = (t, terms) => {
  const h = hay(t);
  return (terms || []).some((w) => h.includes(' ' + w + ' '));
};
// The page's amount rule: to the cent below €200, within 2% from €200 up.
const amtOk = (out, a) => (a < 200 ? Math.abs(out - a) < 0.005 : Math.abs(out - a) <= a * 0.02);
const eur = (v) => '€' + (Math.round(Math.abs(v) * 100) % 100 ? Math.abs(v).toFixed(2) : String(Math.round(Math.abs(v))));
const andList = (l) => (l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]);

// The date and hour in the Netherlands.
export function nlParts(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, y: Number(p.year), m: Number(p.month), day: Number(p.day), hour: Number(p.hour) };
}

function accountIn(meta, k) {
  for (const c of (meta && meta.conns) || []) {
    for (const a of c.accounts || []) if (a.k === k) return { bank: c.bank, a };
  }
  return null;
}
const acctName = (x) => String(x.bank || '').replace(/\s+(Bank|N\.?V\.?|UAB)$/i, '') + (x.a.iban4 ? ' ··' + x.a.iban4 : '');

/* Debits that came back: credit id -> debit, newest debit first. `isBill` says
   whether a debit was for one of the plan's bills. */
export function findBounces(list, isBill) {
  const used = new Set();
  const out = [];
  for (const cr of list) {
    if (!(cr.amt > 0) || cr.own) continue;
    const storno = STORNO.test(normText(`${cr.who || ''} ${cr.desc || ''}`).join(' '));
    const pk = payeeKey(payeeOf(cr));
    const c100 = Math.round(cr.amt * 100);
    const db = list.find((d) => {
      if (!(d.amt < 0) || d.own || used.has(d.id) || d.k !== cr.k || Math.round(-d.amt * 100) !== c100) return false;
      const g = gap(d.d, cr.d);
      if (g < 0 || g > BOUNCE_DAYS) return false;
      return pk && payeeKey(payeeOf(d)) === pk ? isBill(d) || storno : storno && isBill(d);
    });
    if (!db) continue;
    used.add(db.id);
    out.push({ credit: cr, debit: db });
  }
  return out;
}

/* What is still to go out of each bill this month: the month's debits fill the bills
   they name, the one whose amount matches first, as the page does. */
export function billsLeft(bills, list, ym, skip) {
  const items = bills.map((b) => ({ ...b, left: b.a }));
  const month = list
    .filter((t) => t.d.slice(0, 7) === ym && t.amt < 0 && !t.own && !skip.has(t.id))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  for (const t of month) {
    const out = -t.amt;
    let named = items.filter((b) => hits(t, b.t));
    if (!named.length) {
      const am = items.find((b) => !b.o && b.a >= 10 && b.left > 0.004 && amtOk(out, b.a));
      if (am) named = [am];
    }
    if (!named.length) continue;
    const exact = named.filter((b) => b.left > 0.004 && amtOk(out, b.a));
    const order = exact.length ? [...exact, ...named.filter((b) => !exact.includes(b))] : named;
    let amt = out;
    for (const b of order) {
      const q = Math.min(amt, Math.max(0, b.left));
      b.left = r2(b.left - q);
      amt = r2(amt - q);
    }
  }
  return items;
}

// Every alert the watch would send now, each with a key that says when it is new.
export function findAlerts(doc, meta, list, p) {
  const out = [];
  const ym = p.date.slice(0, 7);
  const first = ym + '-01';
  const bills = (doc.bills || []).filter((b) => doc.m === ym || !b.o);
  const isBill = (t) => bills.some((b) => hits(t, b.t));

  const bounces = findBounces(list, isBill);
  const skip = new Set(bounces.map((x) => x.debit.id));
  const recent = addDays(p.date, -7);
  for (const { credit, debit } of bounces) {
    if (credit.d < recent) continue;
    const bill = bills.find((b) => hits(debit, b.t));
    out.push({
      key: `b|${credit.id}`,
      kind: 'bounce',
      text: `${bill ? bill.n : clean(payeeOf(debit), 40) || 'A direct debit'} bounced: ${eur(debit.amt)} came back. Pay it by hand.`,
    });
  }

  const lastDay = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
  const byK = {};
  for (const b of billsLeft(bills, list, ym, skip)) {
    if (!b.d || !b.k || b.left <= 0.004) continue;
    const due = `${ym}-${pad2(Math.min(b.d, lastDay))}`;
    const g = gap(p.date, due);
    if (g < 0 || g > SOON_DAYS) continue;
    (byK[b.k] = byK[b.k] || []).push({ ...b, due });
  }
  for (const [k, due] of Object.entries(byK)) {
    const x = accountIn(meta, k);
    if (!x || !Number.isFinite(x.a.bal)) continue;
    const need = r2(due.reduce((s, b) => s + b.left, 0));
    if (x.a.bal >= need) continue;
    const names = due.map((b) => b.n.replace(/\s*\(.*\)$/, '')).sort();
    const last = due.map((b) => b.due).sort().pop();
    const by = new Date(last + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    out.push({
      key: `s|${k}|${ym}|${names.join('+')}`,
      kind: 'short',
      text: `${eur(need - x.a.bal)} short in ${acctName(x)} for ${andList(names)} (by ${by}).`,
    });
  }

  if (p.day >= 2) {
    const missing = [];
    for (const pk of doc.pockets || []) {
      if (!pk.k || !(pk.b > 0)) continue;
      const x = accountIn(meta, pk.k);
      if (!x || !Number.isFinite(x.a.bal) || x.a.bal >= pk.b) continue;
      const credits = list.filter((t) => t.k === pk.k && t.amt > 0);
      // Only a pocket whose top-ups the bank has shown before can be missing one.
      if (!credits.some((t) => t.d < first)) continue;
      const inMonth = credits.filter((t) => t.d >= first).reduce((s, t) => s + t.amt, 0);
      if (inMonth >= pk.b * 0.5) continue;
      missing.push(pk.n);
    }
    if (missing.length) {
      out.push({
        key: `t|${ym}|${missing.slice().sort().join('+')}`,
        kind: 'topup',
        text: `${andList(missing)} ${missing.length > 1 ? 'pockets are' : 'pocket is'} not topped up yet.`,
      });
    }
  }
  return out;
}

// After every sync: send what is new, remember it, forget keys older than 70 days.
export async function checkWatch(env, code, meta, list, now = new Date()) {
  const key = `watch:${code}`;
  const doc = await read(env, key);
  if (!doc) return [];
  const p = nlParts(now);
  const sent = { ...(doc.sent || {}) };
  const floor = addDays(p.date, -70);
  let pruned = false;
  for (const k of Object.keys(sent)) if (sent[k] < floor) { delete sent[k]; pruned = true; }
  const fresh = findAlerts(doc, meta, list, p).filter((a) => !sent[a.key]);
  if (!fresh.length || p.hour < 7 || p.hour >= 22) {
    if (pruned) await write(env, key, { ...doc, sent });
    return [];
  }
  const url = fresh.every((a) => a.kind === 'topup') ? './#today' : './#bills';
  await notify(env, code, { title: 'Runway', body: fresh.map((a) => a.text).join(' ').slice(0, 180), url }, null, null);
  for (const a of fresh) sent[a.key] = p.date;
  await write(env, key, { ...doc, sent });
  return fresh;
}

export async function handleWatch(request, env, code, json) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.bills)) return json({ error: 'bills required' }, 400);
  const KEY = /^[0-9a-f]{10}$/;
  const bills = body.bills
    .slice(0, 60)
    .map((b) => ({
      n: clean(b && b.n, 60),
      t: (Array.isArray(b && b.t) ? b.t : []).slice(0, 8).map((w) => normText(w).join(' ')).filter((w) => w.length >= 3),
      a: r2(Number(b && b.a)),
      d: Number.isInteger(b && b.d) && b.d >= 1 && b.d <= 31 ? b.d : null,
      k: typeof (b && b.k) === 'string' && KEY.test(b.k) ? b.k : null,
      o: b && b.o ? 1 : 0,
    }))
    .filter((b) => b.n && Number.isFinite(b.a) && b.a > 0);
  const pockets = (Array.isArray(body.pockets) ? body.pockets : [])
    .slice(0, 8)
    .map((x) => ({ k: typeof (x && x.k) === 'string' && KEY.test(x.k) ? x.k : null, n: clean(x && x.n, 30), b: r2(Number(x && x.b)) }))
    .filter((x) => x.k && x.n && Number.isFinite(x.b) && x.b > 0);
  const key = `watch:${code}`;
  const prev = (await read(env, key)) || {};
  await write(env, key, {
    m: /^\d{4}-\d{2}$/.test(body.m) ? body.m : null,
    bills,
    pockets,
    by: clean(body.by, 24) || null,
    at: new Date().toISOString(),
    sent: prev.sent || {},
  });
  return json({ ok: true, bills: bills.length, pockets: pockets.length });
}
