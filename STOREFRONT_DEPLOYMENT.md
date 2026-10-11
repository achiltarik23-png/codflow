# Storefront deployment — Vercel is the only production target

**Status:** decided 2026-10-11. Nothing was deleted when this was recorded —
see "Obsolete Cloudflare configuration" for the cleanup list.

## The rule

> **The storefront is deployed via Vercel. Do not use `npm run deploy`
> Cloudflare for the frontend.**

The API and the dashboard stay on Cloudflare. Only the storefront moved.

> The storefront of production is served by Vercel via the account that owns
> the `matjar.live` domain. The exact Vercel project must be verified from that
> account.

| Tier | Platform | Serves | Deployed by |
|---|---|---|---|
| API | Cloudflare Workers | `api.matjar.live` | `cod-server npm run deploy` |
| Dashboard | Cloudflare Workers | `app.matjar.live` | `cod-client-astro npm run deploy` |
| **Storefront** | **Vercel** | `matjar.live`, `www.matjar.live` | Vercel, from the domain owner's account |

## Evidence

Measured 2026-10-11, read-only.

**Response headers**

```
GET https://www.matjar.live/
  HTTP/1.1 200 OK
  Server: Vercel
  X-Vercel-Id: cdg1::iad1::rnkrq-1791742972455-c18d58e40f15
  X-Vercel-Cache: STALE
```

**DNS**

```
www.matjar.live   CNAME → b65787aa8966b75a.vercel-dns-017.com
                   A     → 216.198.79.1, 64.29.17.1
matjar.live       A     → 216.198.79.65, 64.29.17.65
api.matjar.live   A     → 188.114.96.7, 188.114.97.7   (Cloudflare)
```

`matjar.live` resolves to Vercel anycast on both apex and `www`. The API
resolves to Cloudflare. The two platforms are cleanly separated.

The apex-to-`www` 308 is a **Vercel** redirect, not a Cloudflare zone setting.

## Why the Cloudflare storefront path is a no-op

`cod-astro/theme01` still supports both targets — `astro.config.mjs` picks the
adapter from `DEPLOY_TARGET`:

```js
const adapter = isVercel
  ? (await import("@astrojs/vercel")).default()
  : (await import("@astrojs/cloudflare")).default({ … });
```

`npm run deploy` runs `scripts/deploy.mjs`, which calls
`wrangler deploy --var COD_SERVER_URL:…` against `wrangler.jsonc`:

```jsonc
{ "name": "achil-codflow-theme01",
  "routes": [{ "pattern": "matjar.live/*", "zone_name": "matjar.live" }] }
```

**A Cloudflare Worker route requires the zone to live in the same Cloudflare
account, with DNS proxied through Cloudflare.** `matjar.live` is a Vercel
domain, so the route never fires. Confirmed on the deployed Worker
`achil-codflow-theme01`:

| Check | Result |
|---|---|
| Secrets | none — `wrangler secret list` returns `[]` |
| `STORE_API_KEY` binding | a plain environment variable with value `""` |
| `*.workers.dev` | 404 (`workers_dev: false`) |
| Traffic received | none |

So the storefront authenticates to `/store/config` with a working key while
this Worker holds none — because Vercel serves the site and holds the key.

**A `npm run deploy` here succeeds, reports success, and changes nothing in
production.** That silent no-op is why the Cloudflare path is documented rather
than merely deprecated.

## Storefront variables

Production values live in the **Vercel project environment** of the account
owning `matjar.live`, not in this repository. There is no `vercel.json` tracked
here, and `.vercel/` is gitignored (`cod-astro/theme01/.gitignore:8`), so the
storefront's production configuration is only auditable from the Vercel
dashboard.

| Variable | Where it must be set |
|---|---|
| `STORE_API_KEY` | Vercel env — must match `store_api_keys.key_hash` in D1 |
| `COD_SERVER_URL` | Vercel env (e.g. `https://api.matjar.live`) |
| `MEDIA_DOMAIN` | Vercel env, optional |

All three are declared `context: "server", access: "secret"` in
`astro.config.mjs`, so Astro resolves them at **runtime** from the platform's
bindings. Verified: building with a populated `.dev.vars` does **not** bake
those values into `dist/` — the only `localhost` string in the server bundle is
the source fallback `?? "http://localhost:8787"` in `src/core/api/client.ts`.

### What is verified, and what is not

Confirmed by measurement on 2026-10-11:

- `matjar.live` and `www.matjar.live` are served by **Vercel** (headers + DNS).
- The storefront successfully reads the D1 store configuration, so the
  `STORE_API_KEY` held on that Vercel project **matches the hashed key in the
  database**. Frontend and backend are aligned.
- `STORE_API_KEY`, `COD_SERVER_URL` and `DEPLOY_TARGET` exist as **Secrets**,
  scoped to Production only. Values are never readable from outside the
  dashboard.

**Not verified — and not to be assumed:**

- **The name of the Vercel project serving the domain.** A Vercel account
  reachable from a developer machine holds `codflow-juldase-storefront`,
  `theme01` and `codflow-os-storefront`, serves `0` domains, and renders three
  *different* stores — none of them `matjar.live`. The project that actually
  serves production therefore lives in a different Vercel account.
- **The deployment mechanism** (Git integration, CLI, dashboard). Do not
  assume one; check the project settings.
- **The values** of the variables above.

Anyone auditing this must start from the account that owns `matjar.live`.

## Obsolete Cloudflare configuration

Identified, **not deleted**. Each needs an explicit go-ahead.

| Item | Where | Why it is obsolete | Risk if left |
|---|---|---|---|
| Worker `achil-codflow-theme01` | Cloudflare account | storefront is on Vercel; no traffic, no secrets | someone runs `npm run deploy` and believes it shipped |
| Route `matjar.live/*` on that Worker | `cod-astro/theme01/wrangler.jsonc` | never fires — the domain is Vercel | misleading; reads as the production route |
| `npm run deploy` + `scripts/deploy.mjs` | `cod-astro/theme01/package.json`, `scripts/` | deploys to the no-op target | silent no-op deploy |
| `wrangler.toml` `[env.production]` | `cod-server/wrangler.toml` | `achil-codflow-server-production` does not exist | `--env production` would create a second Worker **with no secrets**, breaking auth |

### Suggested cleanup, in order

1. Delete the Worker `achil-codflow-theme01` on Cloudflare.
2. Decide whether `wrangler.jsonc` stays (harmless, still documents the
   Cloudflare build target) or goes with the deploy script.
3. Remove or empty the dead `[env.production]` block in
   `cod-server/wrangler.toml`, and fix the `codflow-setup` skill that tells
   people to deploy with `--env production`.

Steps 2 and 3 touch tracked files and change deploy behaviour — do them as
their own commit, after step 1 is confirmed.

## Both build targets stay working

The theme is meant to be deployable to either platform, so do not remove the
Cloudflare branch from `astro.config.mjs` or the `build:cf` script. Keep both
paths building; only Vercel is the storefront.

## Verify a storefront change

```sh
cd cod-astro/theme01
npx astro check          # 0 errors expected
npm test                 # 29 files
npm run build:vercel     # build the Vercel adapter locally
```

A green `npm run build` alone does not mean the change reached production. The
build command and the deploy trigger of the production Vercel project are not
verified from this repository — confirm them in the dashboard of the account
owning `matjar.live` before assuming a push ships.