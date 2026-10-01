/* Alerts: Web Push to the phones that asked for it.
 *
 *   GET  /api/vapid               -> { key }                          the public VAPID key
 *   POST /api/push/:code          <- { by, sub }                      this phone wants alerts
 *   POST /api/push/:code/off      <- { endpoint }                     this phone no longer does
 *   POST /api/notify/:code        <- { title, body, to? }             (Bearer ADMIN_TOKEN)
 *                                 -> { sent, phones }                 to = a first name, else everyone
 *
 * Anyone with the code can sign a phone up, the same as reading the plan. The text
 * of an alert is written by the owner and travels encrypted (RFC 8291).
 */

import { sendPush } from './push.js';

const MAX_SUBS = 12;

function cleanBy(v) {
  return String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 24);
}
function cleanText(v, n) {
  return String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n);
}
async function readSubs(env, code) {
  const raw = await env.RUNWAY_KV.get(`push:${code}`);
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
const writeSubs = (env, code, list) => env.RUNWAY_KV.put(`push:${code}`, JSON.stringify(list));

/* Sends to every matching phone (to: only that name, not: everyone but that name); drops the ones the push service says are gone. */
export async function notify(env, code, msg, to, not) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, phones: 0, error: 'no vapid keys' };
  const subs = await readSubs(env, code);
  const want = to ? to.toLowerCase() : null;
  const skip = not ? not.toLowerCase() : null;
  const keep = [];
  let sent = 0, phones = 0;
  for (const s of subs) {
    const by = String(s.by || '').toLowerCase();
    if ((want && by !== want) || (skip && by === skip)) { keep.push(s); continue; }
    phones++;
    let status = 0;
    try { status = await sendPush(s.sub, JSON.stringify(msg), env); } catch (e) { status = 0; }
    if (status === 404 || status === 410) continue;
    if (status >= 200 && status < 300) sent++;
    keep.push(s);
  }
  if (keep.length !== subs.length) await writeSubs(env, code, keep);
  return { sent, phones };
}

export async function alertRoutes(request, env, url, json) {
  const path = url.pathname;
  if (path === '/api/vapid' && request.method === 'GET') return json({ key: env.VAPID_PUBLIC_KEY || null });

  const m = path.match(/^\/api\/(push|notify)\/([a-z0-9]+)(\/off)?$/i);
  if (!m || request.method !== 'POST') return null;
  const code = m[2].toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(code)) return json({ error: 'bad code' }, 400);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'body' }, 400);

  if (m[1] === 'notify') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'admin token required' }, 401);
    const msg = { title: cleanText(body.title, 60) || 'Runway', body: cleanText(body.body, 180), url: cleanText(body.url, 300) || undefined };
    return json(await notify(env, code, msg, cleanBy(body.to)));
  }

  if (!(await env.RUNWAY_KV.get(`plan:${code}`))) return json({ error: 'no plan for this code' }, 404);
  const subs = await readSubs(env, code);
  if (m[3]) {
    const ep = String(body.endpoint || '');
    const keep = subs.filter((s) => s.sub.endpoint !== ep);
    if (keep.length !== subs.length) await writeSubs(env, code, keep);
    return json({ ok: true });
  }
  const sub = body.sub;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 ||
      !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
    return json({ error: 'bad subscription' }, 400);
  }
  const rec = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, by: cleanBy(body.by), at: new Date().toISOString() };
  const list = subs.filter((s) => s.sub.endpoint !== sub.endpoint).concat([rec]).slice(-MAX_SUBS);
  await writeSubs(env, code, list);
  return json({ ok: true });
}
