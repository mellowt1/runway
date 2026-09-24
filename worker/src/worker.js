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
 *
 * Anyone with the code can read all three and write state and spends. That is the
 * point: one person sends the other a link, the other moves a slider, and the next
 * poll on the first phone shows it. No accounts. No figures in the repo.
 *
 *   GET    /api/plan/:code         -> { plan, state, updated, by, rev, spends }
 *   PUT    /api/plan/:code         <- { plan }            (Authorization: Bearer <ADMIN_TOKEN>)
 *   POST   /api/state/:code        <- { by, state }       -> { ok, updated, rev }
 *   DELETE /api/state/:code        <- { by }              -> { ok, updated, rev }   back to the plan
 *   POST   /api/spend/:code        <- { by, spend }       -> { ok, spend, rev }     upsert by spend.id
 *   DELETE /api/spend/:code/:id    <- { by }              -> { ok, removed, rev }
 *
 * State and spends each keep their own `rev`, bumped on every write. The plan GET
 * returns their sum: both only ever increase, so the sum still tells a client
 * "something changed" cheaply. The POST/DELETE responses carry their own doc's rev.
 */

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

function cors(request) {
  const o = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(o) ? o : 'https://mellowt1.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    return json(
      {
        plan,
        state: st.state || null,
        updated: st.updated || null,
        by: st.by || null,
        rev: (st.rev || 0) + (sp.rev || 0),
        spends: Array.isArray(sp.list) ? sp.list : [],
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
    await env.RUNWAY_KV.put(planKey, text, { expirationTtl: TTL });
    return json({ ok: true, bytes: text.length }, request);
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

export default {
  async fetch(request, env) {
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

    return json({ error: 'not found' }, request, 404);
  },
};
