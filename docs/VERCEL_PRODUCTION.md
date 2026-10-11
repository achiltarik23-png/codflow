# Vercel production — the storefront

Reference for the storefront deployment. Companion to
[`STOREFRONT_DEPLOYMENT.md`](../STOREFRONT_DEPLOYMENT.md), which records why
Vercel is the only storefront target.

**No secret values appear in this repository or in this file.** Variable names
are listed; their values live in the Vercel dashboard and must stay there.

## Role in the architecture

CodFlow runs on two platforms. Vercel carries exactly one tier.

| Tier | Platform | Serves |
|---|---|---|
| API | Cloudflare Workers | `api.matjar.live` |
| Dashboard | Cloudflare Workers | `app.matjar.live` |
| **Storefront** | **Vercel** | `matjar.live`, `www.matjar.live` |

The storefront is an Astro app in `cod-astro/theme01`, built with the Vercel
adapter (`@astrojs/vercel` + `cacheVercel()`), selected by `DEPLOY_TARGET` at
build time. It calls cod-server **server-side** and proxies a small set of
endpoints through its own same-origin `/api/*` routes, so the browser never
holds the store key.

The Cloudflare path in this package (`npm run deploy` →
`scripts/deploy.mjs` → Worker `achil-codflow-theme01`) receives no traffic and
changes nothing. Do not use it for the frontend.

## Production domain

`https://www.matjar.live` — the apex `https://matjar.live` 308-redirects to it.

Verified 2026-10-11, read-only:

```
GET https://www.matjar.live/
  Server: Vercel
  X-Vercel-Id: cdg1::iad1::rnkrq-1791742972455-c18d58e40f15
  X-Vercel-Cache: STALE

DNS  www.matjar.live -> CNAME b65787aa8966b75a.vercel-dns-017.com
DNS  api.matjar.live -> 172.67.154.214 / 104.21.6.91   (Cloudflare)
```

## Configuration ownership

> The production storefront is served by Vercel via the account that owns the
> `matjar.live` domain. The exact Vercel project must be verified from that
> account.

Nothing about that project is recorded in this repository:

- there is no `vercel.json` — deliberately not added, so that build and
  deployment settings stay in the dashboard where they are auditable by the
  account owner;
- `.vercel/` is gitignored (`cod-astro/theme01/.gitignore:8`);
- the repository therefore cannot state the project name, its build command,
  its root directory, or its deploy trigger.

A Vercel account reachable from some developer machines holds
`codflow-juldase-storefront`, `theme01` and `codflow-os-storefront`. They
serve **0 domains** and each renders a **different store** — none of them is
`matjar.live`. Production lives in a different account.

## Variables

Names only. **Values live in the Vercel project environment.**

### Declared in the Astro config (`cod-astro/theme01/astro.config.mjs`)

All three are `context: "server", access: "secret"`, so Astro resolves them at
**runtime** from the platform's bindings — they are not baked into the build.

| Variable | Required | Purpose |
|---|---|---|
| `STORE_API_KEY` | yes | Sent as `X-Store-API-Key` to cod-server. Must match a `store_api_keys.key_hash` row. |
| `COD_SERVER_URL` | yes | Origin of cod-server, e.g. `https://api.matjar.live`. |
| `MEDIA_DOMAIN` | no | Custom domain in front of the R2 bucket. Unset → image URLs pass through unchanged. |

### Build-time, not declared in the schema

| Variable | Purpose |
|---|---|
| `DEPLOY_TARGET` | `= vercel` selects the Vercel adapter and cache provider. |

`npm run build:vercel` sets it; `npm run build:cf` sets `cloudflare`. A build
with it unset produces the Cloudflare adapter and will not run correctly on
Vercel.

### Confirming a variable is set

On Vercel sibling projects these three appear as `Secret`, scoped to
`Production` only. The production project's own variable list has **not** been
audited — confirm it in the dashboard. Never print a value, including in a
support ticket.

## Deployment

The production project is driven from its Vercel account. The repository
cannot deploy it, and does not try: there is no deploy script and no
`vercel.json`.

Before changing anything, confirm in the dashboard of the owning account:

1. the project serving `www.matjar.live`;
2. its **Root Directory** — this is a monorepo, so a root of `.` builds the
   whole workspace and `npm run build:vercel` resolves from `cod-astro/theme01`;
3. its **Build Command**;
4. its **Install Command** — sibling projects use `npm install --legacy-peer-deps`;
5. its **Output Directory** — Astro's server output leaves it empty, the
   adapter packages it;
6. that **Include source files outside the Root Directory** is enabled, or
   `cod-astro/theme01` cannot import `../../cod-shared/*` or read
   `cod-server/scripts/cloud-env.mjs`;
7. the three variables above are set as secrets, scoped to production.

### Verifying a deploy

```sh
curl -sI https://www.matjar.live/ | grep -i -E 'server|x-vercel-id'
```

Expect `Server: Vercel`. If the Cloudflare Worker answers instead, you are
looking at the wrong target.

A green local build does **not** mean the change shipped:

```sh
cd cod-astro/theme01
npx astro check
npm test
npm run build:vercel      # builds the Vercel adapter locally
```

then confirm the deployment in the dashboard.

### Rolling back

Use the dashboard's deployment list to promote a previous build. There is no
rollback script in the repository.

## Rotating `STORE_API_KEY`

**No key value appears in this document.** The new key is displayed exactly
once and must be copied at that moment; there is no way to retrieve it
afterwards.

### What rotation actually does

`POST /api/stores/me/api-key/rotate` on cod-server (admin session required)
replaces every key row for the store in a single atomic batch:

- a new key is generated;
- the previous key is **deleted immediately**;
- the raw key is returned once, with `Cache-Control: no-store`.

There is no "prepare then activate" mode. Generating *is* activating.

### Mandatory order

The steps are not interchangeable. Do them in this order.

| # | Action | Where |
|---|---|---|
| 1 | Trigger the rotation | Dashboard → Store settings → API key → **Rotate** |
| 2 | Copy the key from the one-time dialog | The dialog, immediately |
| 3 | Update `STORE_API_KEY` in the Vercel project | Vercel dashboard, Production scope |
| 4 | Redeploy the storefront | Vercel dashboard — see below |
| 5 | Run the validation checks | See "Validating after rotation" |

**Steps 3 and 4 cannot be skipped or reordered.** Vercel injects environment
variables into the deployed function at deploy time; a value saved in the
dashboard does not reach a running deployment until it is redeployed. Saving
the variable without redeploying leaves production on the old, now-dead key.

### The outage window

Between step 1 and the completion of step 4, the storefront holds a key that
no longer matches the database. **Every storefront API call returns `401`.**

The failure is quiet, and this matters more than the outage itself:

- the storefront still returns HTTP `200`;
- `fetchStoreConfig()` returns `null` and every other call returns `null`, `[]`
  or `{}` — no exception is thrown and no error is surfaced;
- pages render with empty data, so the site *looks up*;
- **order submission is the customer-visible break** — the shopper gets an
  order-failed message.

Vercel caching (`X-Vercel-Cache`) may keep serving previously cached pages
during the window, which delays the symptom and can make a failed rotation look
successful. Do not take a cached page as proof the rotation worked — use the
validation checks.

Minimise the window: have the Vercel project open in a second tab before
starting, and run it in low-traffic hours.

### Step 3 — updating the variable

- Edit `STORE_API_KEY` for the **Production** environment only.
- Keep the type `Secret`.
- Do not touch `COD_SERVER_URL`, `MEDIA_DOMAIN` or `DEPLOY_TARGET`.

If you need to recover the value later, it is gone — rotate again.

### Step 4 — redeploying

Redeploy from the Vercel dashboard. The exact trigger of the production
project (git push, dashboard redeploy, CLI) is **not recorded in this
repository** — confirm it in the owning account first. Whichever it is, the
deployment must actually be re-created; editing the variable alone does
nothing.

A successful redeploy shows a fresh deployment id on `www.matjar.live`:

```sh
curl -sI https://www.matjar.live/ | grep -i -E 'x-vercel-id|server'
```

### Validating after rotation

Run all four. The first proves the key is still required, the second that the
storefront authenticates, the third that the browser path works, and the
fourth that no secret leaked.

```sh
# 1. the API still rejects unauthenticated calls
curl -4 -s -o /dev/null -w "%{http_code}\n" https://api.matjar.live/store/config
# expect: 401

# 2. the storefront reads the real store configuration
curl -4 -sL https://www.matjar.live/ | grep -o '<title>[^<]*</title>'
# expect: the store name from D1, NOT a fallback

# 3. a same-origin proxy returns JSON, not an HTML error page
curl -4 -s "https://www.matjar.live/api/product-reviews/probe-1?offset=0&limit=3"
# expect: {"data":[],"total":0}

# 4. no key material in the served page
curl -4 -sL https://www.matjar.live/ | grep -c 'sk_store_'
# expect: 0
```

Check 2 is the one that matters. A storefront showing a fallback store name
after rotation means step 4 did not produce a live deployment carrying the new
variable.

If checks 2–4 fail, redeploy again before touching anything else — an
incomplete redeploy is the usual cause.

### Rotating on the wrong side

`POST /api/stores/me` returns `storeApiKeyConfigured: true|false` and never the
key. There is no endpoint that can recover a key from the database: only a
SHA-256 hash is stored, in `store_api_keys.key_hash`. Losing the key means
rotating, not recovering.

## Security notes

- **Keep secret values out of the repository.** `STORE_API_KEY` must never be
  committed, placed in a `vercel.json`, or pasted into an issue.
- cod-server stores only a SHA-256 **hash** of the key
  (`store_api_keys.key_hash`), never the key itself.
- `.dev.vars` in `cod-astro/theme01` is gitignored and local-only. It is read
  during a build, so never deploy a build produced from a machine whose
  `.dev.vars` points at `localhost` — the deployment will ship a storefront
  that cannot reach its API.