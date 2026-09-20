# Runway

A phone-first page for one person: what is left this month, where the money goes over the months ahead, and the calls still to make. One person moves the sliders; the other sees the result on their own phone within a few seconds.

**No figures live in this repo.** The app ships empty and loads everything from the Worker using the code in the link, so the repo can be public without showing anyone's balance, salary or debts.

## The two documents

Each code holds two things in KV:

| | written by | what it is |
|---|---|---|
| `plan` | the owner, with the admin token | balances, fixed costs, loans, subscriptions, the tasks, the debt list |
| `state` | the app, by whoever opens it | food / going out / misc, which subscriptions are kept, the assumed salary, which month the gemeente lands in, ticked tasks |

The app renders `plan` with `state` laid over it. "Back to the plan" deletes `state` and everything returns to the owner's figures.

## The link

```
https://mellowt1.github.io/runway/?c=<code>&me=<first name>
```

`c` is the code, six to sixteen letters and digits. `me` is the name shown on the other person's screen ("Ada's numbers · 2h ago"); it is remembered after the first visit, so the plain `?c=` link works from then on. Without a code the app asks for one.

## Setting it up

1. **KV** — Cloudflare dashboard → Workers & Pages → KV → Create, call it `RUNWAY`, and paste its id into `worker/wrangler.toml`.
2. **Worker** — deploy `worker/` (git-connected Workers Builds, or `npx wrangler deploy` from that folder). Bind the namespace as `RUNWAY_KV`, and set one secret:
   ```
   npx wrangler secret put ADMIN_TOKEN
   ```
   Any long random string. It is the only thing standing between the internet and overwriting the plan.
3. **Site** — GitHub Pages on this repo, `main` branch, root folder.
4. **The figures** — copy `seed.example.json` to `seed.json`, fill in the real numbers, then:
   ```
   RUNWAY_ADMIN_TOKEN=... ./seed.sh <code>
   ```
   `seed.json` is gitignored. Keep it somewhere outside the repo once you have pushed it.

If the Worker lives somewhere other than `runway-sync.mellowt1.workers.dev`, add `&api=https://…` to the link, or change the default at the top of the script in `index.html`.

## How the live part works

The app polls `GET /api/plan/:code` every eight seconds while the tab is visible, and skips the request when a write of its own is still in flight. Every state write bumps `rev`, so a poll that sees the same `rev` costs one request and changes nothing on screen. Writes are debounced by 700ms, so dragging a slider sends one request, not fifty.

Plan and state are cached in `localStorage`, so the app opens instantly and still works with no signal — it just stops seeing the other person's changes until the connection is back.

## Shape of the plan document

See `seed.example.json`. A few fields carry weight:

- `months` — the whole forecast is driven by this list. Add a month and every screen follows.
- `salary.from` and `extras[].from` — the month an amount starts counting, using a `months` key.
- `bridge` — who covers the stretch below zero, and the two words used for it. The app finds the dip itself and labels it; there is no hardcoded December.
- `flex` — the sliders on the Adjust sheet. Each needs `min`, `max`, `step` and `plan`.

## A note on the figures

Negative balances are never the headline and are never red. The forecast leads with where the money ends up, and the months below zero are drawn as a bridged stretch with the name of whoever covers them. The real figures stay visible in the month list, in grey. That is deliberate — see the `bridge` field.

## Local

```
python3 -m http.server 8080
```

Open `http://localhost:8080/?c=<code>&api=https://runway-sync.mellowt1.workers.dev`. The Worker allows `localhost:8080` as an origin.
