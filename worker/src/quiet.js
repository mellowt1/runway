/* Quiet days: the morning alert after a day with no everyday spending, so the daily
 * scan reaches a phone that is closed.
 *
 * A quiet day has no card payment and no cash entered. Bills, debt payments, savings
 * and money in are not movement. The page decides the same way (its classify() and
 * quiet()); keep the two in step. The Worker only ever says a day was quiet, never
 * that it was not.
 *
 * Once a morning (its own cron, no bank sync), for each code with a bank: if a sync
 * has run since midnight in the Netherlands and yesterday was quiet, the owner's
 * phones get one alert. After a quiet Saturday and Sunday, Monday's says so.
 *
 *   POST /api/quiet/:code/run   admin token: what the check finds now, nothing sent
 *                               (?send=1 sends it as the cron would)
 *
 *   quiet:<code>  { sent: 'YYYY-MM-DD' }
 */

import { notify } from './alerts.js';
import { normText, nlParts } from './watch.js';

const TTL = 400 * 24 * 3600;
const LOOK_BACK = 90;
const SAVINGS = /(^| )(spaar[a-z]*|sparen|direct sparen|savings?|vaults?|pockets?|deposito|vermogen[a-z]*)( |$)/;
const CARD_DAY = /(?:^|[ ,])(\d{2})\.(\d{2})\.(\d{2})\/\d{2}[.:]\d{2}/;

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const gap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const payeeKey = (s) => normText(s).slice(0, 3).join(' ');

async function read(env, key) {
  const raw = await env.RUNWAY_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// The day a card payment was made, when the bank's text carries it (the page's cardDay).
function dayOf(t) {
  if (!(t.amt < 0) || t.own) return t.d;
  const m = String(t.desc || '').match(CARD_DAY);
  if (!m) return t.d;
  const d = `20${m[3]}-${m[2]}-${m[1]}`;
  const g = gap(d, t.d);
  return g > 0 && g <= 7 ? d : t.d;
}

function terms(x) {
  const t = x.payee || x.name;
  return (Array.isArray(t) ? t : [t]).map((s) => normText(s).join(' ')).filter((s) => s.length >= 3);
}

// Is this payment everyday spending? The page's classify(), for debits only.
export function isEveryday(t, plan, tags) {
  if (!(t.amt < 0) || t.own) return false;
  const tag = ((tags && tags.pay) || {})[t.id] || {};
  if (tag.hide || tag.ns) return false;
  if (tag.b) return tag.b === 'everyday';
  const rule = ((tags && tags.payee) || {})[payeeKey(t.who || t.desc || '')];
  if (rule && rule.b) return rule.b === 'everyday';
  const words = normText(`${t.who || ''} ${t.desc || ''}`).join(' ');
  if (SAVINGS.test(words)) return false;
  const desc = String(t.desc || '').replace(/\s+/g, '').toUpperCase();
  const bank = plan.bank || {};
  if ((bank.manual || []).some((m) => {
    const ib = String(m.iban || '').replace(/\s+/g, '').toUpperCase();
    return ib.length >= 8 && desc.includes(ib);
  })) return false;
  const hay = ' ' + words + ' ';
  const named = [
    ...(bank.rules || []).map((r) => terms({ payee: r.match })),
    ...(plan.fixed || []).map(terms),
    ...(plan.subs || []).filter((s) => !s.cancelled).map(terms),
    ...(plan.loans || []).map(terms),
  ].some((list) => list.some((w) => hay.includes(' ' + w + ' ')));
  if (named) return false;
  const out = -t.amt;
  const bills = [...(plan.fixed || []), ...(plan.loans || []), ...(plan.subs || []).filter((s) => !s.cancelled)];
  if (bills.some((x) => {
    const a = Number(x.amount) || 0;
    return a >= 10 && (a < 200 ? Math.abs(out - a) < 0.005 : Math.abs(out - a) <= a * 0.02);
  })) return false;
  return out < (bank.big || 500);
}

/* Yesterday and the run behind it. `today` is the date in the Netherlands. */
export function quietState(plan, tags, list, spends, today) {
  const moved = new Set();
  let first = null;
  for (const t of list || []) {
    const d = dayOf(t);
    if (!first || d < first) first = d;
    if (isEveryday(t, plan, tags)) moved.add(d);
  }
  for (const s of spends || []) if (s && s.dir !== 'in' && s.d) moved.add(s.d);
  if (!first) return null;
  if (plan.asOf && first < plan.asOf) first = plan.asOf;
  const floor = addDays(today, -LOOK_BACK);
  if (first < floor) first = floor;
  let run = 0;
  for (let d = addDays(today, -1); d >= first && !moved.has(d); d = addDays(d, -1)) run++;
  // Monday morning after a quiet Saturday and Sunday.
  const weekend = new Date(today + 'T12:00:00Z').getUTCDay() === 1 && run >= 2;
  return { quiet: run > 0, run, weekend };
}

export function quietText(st) {
  const tail = st.run >= 2 ? ` ${st.run} days in a row.` : '';
  return (st.weekend ? 'No movement all weekend. Crew in hypersleep.' : 'No movement detected yesterday.') + tail + ' Run the scan.';
}

// Has every pocket (or, with none linked, the bank) synced since midnight?
function syncedToday(meta, tags, plan, today) {
  const pockets = Object.entries((tags && tags.acct) || {})
    .filter(([, v]) => v && (plan.flex || []).some((f) => f.id === v.p))
    .map(([k]) => k);
  const times = [];
  for (const c of (meta && meta.conns) || []) {
    for (const a of c.accounts || []) if (pockets.includes(a.k) && a.synced) times.push(a.synced);
  }
  const at = times.sort()[0] || (meta && meta.synced);
  return !!at && nlParts(new Date(at)).date >= today;
}

export async function quietFor(env, code, now = new Date(), send = true) {
  const p = nlParts(now);
  const [plan, meta, tx, tags, sp, doc] = await Promise.all([
    read(env, `plan:${code}`), read(env, `bank:${code}`), read(env, `banktx:${code}`),
    read(env, `tags:${code}`), read(env, `spends:${code}`), read(env, `quiet:${code}`),
  ]);
  const owner = plan && plan.people && plan.people.owner;
  if (!owner || !meta || !tx || !Array.isArray(tx.list)) return { skip: 'no bank' };
  if (!syncedToday(meta, tags, plan, p.date)) return { skip: 'not synced today' };
  const st = quietState(plan, tags, tx.list, sp && sp.list, p.date);
  if (!st) return { skip: 'no payments' };
  const out = { ...st, already: !!(doc && doc.sent === p.date) };
  if (!send || !st.quiet || out.already || p.hour < 7 || p.hour >= 22) return out;
  const r = await notify(env, code, { title: 'MOTHER', body: quietText(st), url: './#today' }, owner, null);
  await env.RUNWAY_KV.put(`quiet:${code}`, JSON.stringify({ sent: p.date }), { expirationTtl: TTL });
  return { ...out, sent: r.sent, phones: r.phones };
}

export async function quietPing(env, now = new Date()) {
  let cursor;
  do {
    const page = await env.RUNWAY_KV.list({ prefix: 'bank:', cursor });
    for (const k of page.keys) {
      const code = k.name.slice(5);
      try {
        const r = await quietFor(env, code, now, true);
        if (r && r.sent !== undefined) console.log('quiet', code, JSON.stringify({ run: r.run, sent: r.sent }));
      } catch (e) {
        console.log('quiet failed', code, e && e.message);
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

export async function handleQuietRun(request, env, code, url, json) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'admin token required' }, 401);
  return json(await quietFor(env, code, new Date(), url.searchParams.get('send') === '1'));
}
