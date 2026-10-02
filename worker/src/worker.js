/* runway-sync
 *
 * The small relay behind Runway. It holds three documents per code:
 *
 *   plan    the figures the owner maintains: balances, fixed costs, loans, subscriptions,
 *           the tasks, the debt list. Written once by the owner with the admin token,
 *           never by the app.
 *   state   the parts the reader steers: what they spend on food, going out and misc,
 *           which subscriptions they keep, the salary they assume, which month the
 *           gemeente lands in, and which tasks they have ticked off.
 *   spends  what was actually spent, one entry per purchase. Kept apart from state on
 *           purpose: state is whole-document last-writer-wins, so a slider moved on a
 *           stale page must never be able to erase a logged spend, and "back to the
 *           plan" resets the what-ifs, never the facts.
 *   manual  newer balances for the accounts the plan lists as entered by hand (a
 *           savings account no bank connection covers), typed in by the reader. Also
 *           a fact, so also out of reach of "back to the plan".
 *   tasks   to-dos either person adds, each for one of them, with its tick. The
 *           plan's own tasks stay in the plan; their ticks stay in state.
 *
 * Anyone with the code can read all of them and write state, spends, manual and tasks. That is the
 * point: one person sends the other a link, the other moves a slider, and the next
 * poll on the first phone shows it. No accounts. No figures in the repo.
 *
 *   GET    /api/plan/:code         -> { plan, state, updated, by, rev, spends }
 *   PUT    /api/plan/:code         <- { plan }            (Authorization: Bearer <ADMIN_TOKEN>)
 *   POST   /api/state/:code        <- { by, state }       -> { ok, updated, rev }
 *   DELETE /api/state/:code        <- { by }              -> { ok, updated, rev }   back to the plan
 *   POST   /api/spend/:code        <- { by, spend }       -> { ok, spend, rev }     upsert by spend.id
 *   DELETE /api/spend/:code/:id    <- { by }              -> { ok, removed, rev }
 *   POST   /api/manual/:code       <- { by, id, bal, asOf } -> { ok, entry, rev }
 *   POST   /api/task/:code         <- { by, task }        -> { ok, task, rev }      upsert by task.id
 *   DELETE /api/task/:code/:id     <- { by }              -> { ok, removed, rev }
 *
 * A task added for someone sends an alert to every phone but the adder's.
 *
 * Alerts (Web Push) are in alerts.js.
 *
 * The plan GET also carries `bank: { pin, conns, rev }` so a phone knows when to fetch
 * the bank side. That side (a PIN, the bank connections, the sync) is in bank.js.
 *
 * State, spends, manual and tasks each keep their own `rev`, bumped on every write. The plan GET
 * returns their sum: both only ever increase, so the sum still tells a client
 * "something changed" cheaply. The POST/DELETE responses carry their own doc's rev.
 */

import { bankRoutes, bankSummary, syncAll } from './bank.js';
import { alertRoutes, notify } from './alerts.js';

const ORIGINS = new Set([
  'https://mellowt1.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);
const CODE = /^[a-z0-9]{6,16}$/;
const TTL = 400 * 24 * 3600;
const MAX_PLAN = 60000;
const MAX_STATE = 8000;
const MAX_SPENDS = 1500;
const SPEND_ID = /^[a-z0-9]{6,16}$/;
const SPEND_CAT = /^[a-z0-9_-]{1,24}$/;
const MANUAL_ID = /^[a-z0-9_-]{1,24}$/;
const MAX_MANUAL = 12;
const MAX_TASKS = 100;

function cors(request) {
  const o = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(o) ? o : 'https://mellowt1.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Runway-Key',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

const json = (data, request, status = 200) =>
  Response.json(data, { status, headers: cors(request) });

// A name is only ever shown back to the two people who share the code.
function cleanBy(v) {
  return String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 24);
}

// State is a flat bag of numbers, a subscription list and ticked tasks. Anything
// else that arrives is dropped rather than stored.
function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of ['sept', 'food', 'out', 'misc', 'salary', 'partner', 'us', 'ics']) {
    const n = Number(s[k]);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) out[k] = Math.round(n * 100) / 100;
  }
  if (typeof s.gem === 'string' && /^[a-z]{1,8}$/i.test(s.gem)) out.gem = s.gem;
  if (Array.isArray(s.subs)) {
    out.subs = s.subs
      .filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,24}$/i.test(x))
      .slice(0, 40);
  }
  if (s.tasks && typeof s.tasks === 'object') {
    const t = {};
    let n = 0;
    for (const [k, v] of Object.entries(s.tasks)) {
      if (n++ >= 40) break;
      if (/^[a-z0-9_-]{1,24}$/i.test(k) && v === true) t[k] = true;
    }
    out.tasks = t;
  }
  return out;
}

// A calendar date as the phone wrote it, YYYY-MM-DD, and one that exists:
// 2026-02-30 matches the pattern and is refused here.
function isRealDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

// One logged entry: a purchase, or money in when dir is "in" (a repayment, a
// transfer). Returns null when anything required is missing or out of range, so a
// bad entry is refused whole rather than stored half-cleaned.
function cleanSpend(s) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.id !== 'string' || !SPEND_ID.test(s.id)) return null;
  if (!isRealDate(s.d)) return null;
  if (typeof s.cat !== 'string' || !SPEND_CAT.test(s.cat)) return null;
  const amt = Number(s.amt);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 100000) return null;
  const out = { id: s.id, d: s.d, cat: s.cat, amt: Math.round(amt * 100) / 100 };
  if (out.amt <= 0) return null;
  if (s.dir === 'in') out.dir = 'in';
  if (typeof s.note === 'string') {
    const note = s.note.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 60).trim();
    if (note) out.note = note;
  }
  return out;
}

async function readDoc(env, key) {
  const raw = await env.RUNWAY_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function handlePlan(request, env, code) {
  const planKey = `plan:${code}`;

  if (request.method === 'GET') {
    const plan = await readDoc(env, planKey);
    if (!plan) return json({ error: 'no plan for this code' }, request, 404);
    const st = (await readDoc(env, `state:${code}`)) || {};
    const sp = (await readDoc(env, `spends:${code}`)) || {};
    const md = (await readDoc(env, `manual:${code}`)) || {};
    const tk = (await readDoc(env, `tasks:${code}`)) || {};
    const bank = await bankSummary(env, code);
    return json(
      {
        plan,
        state: st.state || null,
        updated: st.updated || null,
        by: st.by || null,
        rev: (st.rev || 0) + (sp.rev || 0) + (md.rev || 0) + (tk.rev || 0),
        spends: Array.isArray(sp.list) ? sp.list : [],
        manual: md.set || {},
        tasks: Array.isArray(tk.list) ? tk.list : [],
        bank,
      },
      request
    );
  }

  if (request.method === 'PUT') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return json({ error: 'admin token required' }, request, 401);
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body.plan !== 'object' || !body.plan) {
      return json({ error: 'plan required' }, request, 400);
    }
    const text = JSON.stringify(body.plan);
    if (text.length > MAX_PLAN) return json({ error: 'plan too large' }, request, 413);
    const before = await readDoc(env, planKey);
    await env.RUNWAY_KV.put(planKey, text, { expirationTtl: TTL });
    // A new note from the owner goes out as an alert to the reader's phones.
    const n = body.plan.notice;
    let alerted = null;
    if (n && n.id && (!before || !before.notice || before.notice.id !== n.id)) {
      alerted = await notify(env, code, { title: 'Runway', body: String(n.push || n.body || '').slice(0, 180) }, null,
        body.plan.people && body.plan.people.other);
    }
    return json({ ok: true, bytes: text.length, alerted }, request);
  }

  return json({ error: 'method' }, request, 405);
}

async function handleState(request, env, code) {
  const key = `state:${code}`;
  const body = await request.json().catch(() => null);
  const by = cleanBy(body && body.by);

  if (request.method === 'DELETE') {
    const prev = (await readDoc(env, key)) || {};
    const rec = {
      state: null,
      by: by || prev.by || null,
      updated: new Date().toISOString(),
      rev: (prev.rev || 0) + 1,
    };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    return json({ ok: true, updated: rec.updated, rev: rec.rev }, request);
  }

  if (request.method === 'POST') {
    const state = cleanState(body && body.state);
    if (!state) return json({ error: 'state required' }, request, 400);
    const text = JSON.stringify(state);
    if (text.length > MAX_STATE) return json({ error: 'state too large' }, request, 413);
    const prev = (await readDoc(env, key)) || {};
    const rec = {
      state,
      by: by || null,
      updated: new Date().toISOString(),
      rev: (prev.rev || 0) + 1,
    };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    return json({ ok: true, updated: rec.updated, rev: rec.rev }, request);
  }

  return json({ error: 'method' }, request, 405);
}

// Spends are their own document so no state write can touch them. `id` is only
// set on DELETE /api/spend/:code/:id.
async function handleSpend(request, env, code, id) {
  const key = `spends:${code}`;
  const body = await request.json().catch(() => null);
  const by = cleanBy(body && body.by);

  if (request.method === 'POST' && !id) {
    const spend = cleanSpend(body && body.spend);
    if (!spend) return json({ error: 'spend required: id, d, cat, amt' }, request, 400);
    spend.by = by || null;
    spend.at = new Date().toISOString();
    const prev = (await readDoc(env, key)) || {};
    let list = (Array.isArray(prev.list) ? prev.list : []).filter((x) => x && x.id !== spend.id);
    list.push(spend);
    if (list.length > MAX_SPENDS) {
      // Oldest by date go first; entries with the same date keep their order.
      list = list
        .map((x, i) => [x, i])
        .sort((a, b) => (a[0].d < b[0].d ? -1 : a[0].d > b[0].d ? 1 : a[1] - b[1]))
        .slice(list.length - MAX_SPENDS)
        .map((p) => p[0]);
    }
    const rec = { list, rev: (prev.rev || 0) + 1 };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    return json({ ok: true, spend, rev: rec.rev }, request);
  }

  if (request.method === 'DELETE' && id) {
    if (!SPEND_ID.test(id)) return json({ error: 'bad id' }, request, 400);
    const prev = (await readDoc(env, key)) || {};
    const before = Array.isArray(prev.list) ? prev.list : [];
    const list = before.filter((x) => x && x.id !== id);
    // Deleting what is already gone is not an error (the phone may be retrying),
    // and not a change either: no write, no rev bump.
    if (list.length === before.length) return json({ ok: true, removed: false, rev: prev.rev || 0 }, request);
    const rec = { list, rev: (prev.rev || 0) + 1 };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    return json({ ok: true, removed: true, rev: rec.rev }, request);
  }

  return json({ error: 'method' }, request, 405);
}

// A newer balance for one hand-entered account. The plan says which accounts exist;
// this only carries what the reader typed, keyed by the plan's account id.
async function handleManual(request, env, code) {
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const key = `manual:${code}`;
  const body = await request.json().catch(() => null);
  const by = cleanBy(body && body.by);
  const id = String((body && body.id) || '');
  const bal = Math.round(Number(body && body.bal) * 100) / 100;
  const asOf = String((body && body.asOf) || '');
  if (!MANUAL_ID.test(id)) return json({ error: 'bad id' }, request, 400);
  if (!Number.isFinite(bal) || bal < 0 || bal >= 1e7) return json({ error: 'bad balance' }, request, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return json({ error: 'bad date' }, request, 400);
  const prev = (await readDoc(env, key)) || {};
  const set = Object.assign({}, prev.set || {});
  if (!set[id] && Object.keys(set).length >= MAX_MANUAL) return json({ error: 'too many accounts' }, request, 413);
  const entry = { bal, asOf, by: by || null, at: new Date().toISOString() };
  set[id] = entry;
  const rec = { set, rev: (prev.rev || 0) + 1 };
  await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
  return json({ ok: true, entry, rev: rec.rev }, request);
}

function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id || '');
  const title = String(t.t || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 60).trim();
  const who = cleanBy(t.who).toLowerCase();
  const when = String(t.when || '').replace(/[^\p{L}\p{N} .:-]/gu, '').trim().slice(0, 20);
  if (!SPEND_ID.test(id) || !title || !who) return null;
  return { id, t: title, who, when, done: !!t.done };
}

// Tasks are their own document, like spends: no state write can touch them.
async function handleTask(request, env, code, id) {
  const key = `tasks:${code}`;
  const body = await request.json().catch(() => null);
  const by = cleanBy(body && body.by);

  if (request.method === 'POST' && !id) {
    const task = cleanTask(body && body.task);
    if (!task) return json({ error: 'task required: id, t, who' }, request, 400);
    const prev = (await readDoc(env, key)) || {};
    const list = Array.isArray(prev.list) ? prev.list : [];
    const old = list.find((x) => x && x.id === task.id);
    if (!old && list.length >= MAX_TASKS) return json({ error: 'too many tasks' }, request, 413);
    task.by = old ? old.by : by || null;
    task.at = old ? old.at : new Date().toISOString();
    const rec = { list: list.filter((x) => x && x.id !== task.id).concat([task]), rev: (prev.rev || 0) + 1 };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    let alerted = null;
    if (!old && by) {
      const forWho = task.who.charAt(0).toUpperCase() + task.who.slice(1);
      alerted = await notify(env, code, { title: 'Runway', body: `${by} added a task for ${forWho}: ${task.t}` }, null, by);
    }
    return json({ ok: true, task, rev: rec.rev, alerted }, request);
  }

  if (request.method === 'DELETE' && id) {
    if (!SPEND_ID.test(id)) return json({ error: 'bad id' }, request, 400);
    const prev = (await readDoc(env, key)) || {};
    const before = Array.isArray(prev.list) ? prev.list : [];
    const list = before.filter((x) => x && x.id !== id);
    if (list.length === before.length) return json({ ok: true, removed: false, rev: prev.rev || 0 }, request);
    const rec = { list, rev: (prev.rev || 0) + 1 };
    await env.RUNWAY_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    return json({ ok: true, removed: true, rev: rec.rev }, request);
  }

  return json({ error: 'method' }, request, 405);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request) });
    }
    const url = new URL(request.url);

    const p = url.pathname.match(/^\/api\/plan\/([a-z0-9]+)$/i);
    if (p) {
      const code = p[1].toLowerCase();
      if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
      return handlePlan(request, env, code);
    }

    const s = url.pathname.match(/^\/api\/state\/([a-z0-9]+)$/i);
    if (s) {
      const code = s[1].toLowerCase();
      if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
      return handleState(request, env, code);
    }

    const sp = url.pathname.match(/^\/api\/spend\/([a-z0-9]+)(?:\/([a-z0-9]+))?$/i);
    if (sp) {
      const code = sp[1].toLowerCase();
      if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
      return handleSpend(request, env, code, sp[2] ? sp[2].toLowerCase() : null);
    }

    const tm = url.pathname.match(/^\/api\/task\/([a-z0-9]+)(?:\/([a-z0-9]+))?$/i);
    if (tm) {
      const code = tm[1].toLowerCase();
      if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
      return handleTask(request, env, code, tm[2] ? tm[2].toLowerCase() : null);
    }

    const mn = url.pathname.match(/^\/api\/manual\/([a-z0-9]+)$/i);
    if (mn) {
      const code = mn[1].toLowerCase();
      if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
      return handleManual(request, env, code);
    }

    const reply = (data, status = 200) => json(data, request, status);
    reply.raw = (text, status = 200) =>
      new Response(text, { status, headers: { ...cors(request), 'Content-Type': 'application/json' } });
    const b = await bankRoutes(request, env, ctx, url, reply);
    if (b) return b;
    const a = await alertRoutes(request, env, url, reply);
    if (a) return a;

    return json({ error: 'not found' }, request, 404);
  },

  // Four times a day: the most banks allow for reads without the person present.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};
