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

## Security notes

- **Keep secret values out of the repository.** `STORE_API_KEY` must never be
  committed, placed in a `vercel.json`, or pasted into an issue.
- The value in `STORE_API_KEY` is only a *hash* of the key on the server side
  (`store_api_keys.key_hash`, SHA-256). Rotating means generating a new key via
  `POST /api/stores/me/api-key/rotate` on cod-server and updating the Vercel
  variable in the same operation — a mismatch makes every storefront API call
  return `401`.
- Rotating a key **invalidates the previous one immediately**. Update Vercel
  first, or the storefront breaks between the two steps.
- `.dev.vars` in `cod-astro/theme01` is gitignored and local-only. It is read
  during a build, so never deploy a build produced from a machine whose
  `.dev.vars` points at `localhost` — the deployment will ship a storefront
  that cannot reach its API.