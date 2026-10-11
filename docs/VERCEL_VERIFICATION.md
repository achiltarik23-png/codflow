# Vercel Production Verification

A read-only checklist for the storefront deployment.

**Nothing in this repository can answer these questions.** The storefront is
served by Vercel, which is outside this repository: there is no `vercel.json`,
`.vercel/` is gitignored, and the project name, build command and deploy
trigger are recorded nowhere. This file exists so that someone with access to
the Vercel account can answer them once and write the answers down.

**Scope.** Inspection only. Do not change a setting, do not add a variable, do
not trigger a deploy while filling this in. Record names and states, never
values.

This document separates what was measured from what is still unknown. Do not
promote an item from the second list without measuring it.

---

## 1. Confirmed

Measured from outside the repository on 2026-10-11, by direct request. These
are inputs, not questions.

| Observation | Measured value |
|---|---|
| `GET https://www.matjar.live` | `200`, `Server: Vercel`, `X-Vercel-Id: cdg1::iad1::…` |
| DNS `www.matjar.live` | `CNAME → b65787aa8966b75a.vercel-dns-017.com` |
| DNS `www.matjar.live` | `A → 216.198.79.1`, `64.29.17.1` |
| `GET https://matjar.live` | `308` redirect |
| `GET https://api.matjar.live/health` | `200`, `Server: cloudflare` |
| `GET https://app.matjar.live` | `200`, `Server: cloudflare` |
| `GET https://media.matjar.live/<missing>` | `404`, `Server: cloudflare`, `content-type: text/html` |
| `achil-codflow-server` deployment | Cloudflare Worker, via `wrangler` |
| API `MEDIA_DOMAIN` | `media.matjar.live`, set 2026-10-11, version `534103a2` |
| Storefront source | `cod-astro/theme01` in this repository |

**Known from the repository source, not inferred:**

| Fact | Where |
|---|---|
| `STORE_API_KEY` and `COD_SERVER_URL` are required; `MEDIA_DOMAIN` is optional | `cod-astro/theme01/src/env.d.ts:9,11,13` |
| `build:vercel` sets `DEPLOY_TARGET=vercel` | `cod-astro/theme01/package.json` |
| `DEPLOY_TARGET` alone selects the adapter | `cod-astro/theme01/astro.config.mjs:6` |
| The image optimiser only rewrites URLs on the `MEDIA_DOMAIN` origin | `cod-astro/theme01/src/core/utils/image-optimizer.ts:30` |

**Not confirmed — do not treat as fact:**

- Which Vercel account or project serves `www.matjar.live`.
- Whether `matjar.live` and `www.matjar.live` are one project or two.
- Which Vercel environment variables exist.
- Whether `MEDIA_DOMAIN` is set there.
- Which product answers on `media.matjar.live`. It is Cloudflare and returns
  `404` with a `text/html` body, which does not distinguish an R2 custom domain
  from a Worker route. The Worker has an R2 binding configured, but that is a
  binding on the Worker — not evidence about what serves this domain.

---

## 2. Account owning the domain

**Where:** Vercel dashboard → account switcher.

- [ ] Record the **team / account slug** that holds `www.matjar.live`
- [ ] Record whether it is a personal account or an Organisation
- [ ] Note any other projects in that account that could also claim the domain

---

## 3. Project actually bound to the domain

**Where:** project → Settings → Domains. Or Vercel dashboard → Domains.

- [ ] Record the **project name** and project ID
- [ ] Record which domains it owns: `www.matjar.live`? `matjar.live`? both?
- [ ] Check whether the apex and the `www` belong to the **same project**

> Measured: `matjar.live` returns `308`, `www.matjar.live` returns `200`. Two
> readings fit — one project owning both and redirecting apex→www, or two
> projects involved. Establish which. A deploy to the wrong project looks like
> a successful deploy.

If you use the CLI, `vercel project ls` lists projects. Confirm the exact
subcommand against your installed version before relying on it.

---

## 4. Environment variables — names only

**Where:** project → Settings → Environment Variables.

Expected from `src/env.d.ts` — two required, one optional:

- [ ] List every variable **name** present, per environment:

| Variable | Required by code | Production | Preview | Development | Secret or plain |
|---|---|---|---|---|---|
| `STORE_API_KEY` | yes | ☐ | ☐ | ☐ | |
| `COD_SERVER_URL` | yes | ☐ | ☐ | ☐ | |
| `MEDIA_DOMAIN` | no | ☐ | ☐ | ☐ | |
| _(others found)_ | | | | | |

- [ ] Record **which environments** each is scoped to
- [ ] Record any variable stored as plain text rather than secret, and whether
      that is intended

> Check Preview explicitly. A variable present only in Production will not be
> read by a preview build, and the preview will fail in a way that looks
> unrelated to the variable.

**Never write a value in this document or anywhere else.** The Vercel dashboard
masks secret values. If your CLI version can print values, prefer the dashboard
and do not paste the output.

---

## 5. Is `MEDIA_DOMAIN` set, and to what

Read from `astro:env/server`, consumed in `image-optimizer.ts`. Verbatim:

```ts
// src/core/utils/image-optimizer.ts:20
const MEDIA_DOMAIN = _MEDIA_DOMAIN ? `https://${_MEDIA_DOMAIN.replace(/^https?:\/\//, "")}` : "";

// src/core/utils/image-optimizer.ts:30
if (!MEDIA_DOMAIN || !originalUrl || !originalUrl.startsWith(MEDIA_DOMAIN)) {
```

and the URL it builds, line 54:

```ts
return `${MEDIA_DOMAIN}/cdn-cgi/image/${resizeParams}/${imagePath}`;
```

- [ ] Is `MEDIA_DOMAIN` set in the Vercel project? ☐ yes ☐ no
- [ ] If yes: does its value equal `media.matjar.live`?

The API side is `media.matjar.live` (measured). The three combinations:

| Vercel | API | Code path |
|---|---|---|
| unset | `media.matjar.live` | line 30 returns early, original URL kept |
| `media.matjar.live` | `media.matjar.live` | line 54 builds a `/cdn-cgi/image/` URL |
| any other value | `media.matjar.live` | line 30 returns early, original URL kept |

**No action is required if it is unset.** Both unset cases degrade to passing
the original URL through, which is what the storefront already does.

> Whether Cloudflare actually serves `/cdn-cgi/image/` on that domain is a
> separate question, answered in section 6.

---

## 6. Image / CDN configuration

- [ ] Which Cloudflare product answers `media.matjar.live` — an R2 custom
      domain, or a Worker route? Section 1 could not tell from outside
- [ ] If `/cdn-cgi/image/` is requested on it, does it return an image?
      Check directly:

```sh
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  'https://media.matjar.live/cdn-cgi/image/width=200/<a-real-r2-key>'
```

- [ ] Record any image settings on the Vercel project — framework preset,
      remote patterns, image domain allow-list
- [ ] Note whether a further CDN or cache sits in front of Vercel
- [ ] Confirm `media.matjar.live` is reachable **from Vercel**. Browser CORS
      does not apply to a server-side fetch, so an R2 CORS policy will not be
      the cause of a server-side failure — but verify rather than assume which
      side performs the fetch

---

## 7. Deploy trigger

**Where:** project → Settings → Git, and Settings → Build & Deployment.

- [ ] Trigger: ☐ Git integration ☐ dashboard ☐ CLI ☐ other
- [ ] If Git: which repository, which branch produces Production builds?
- [ ] Build command: ____________________
- [ ] Output directory: ____________________
- [ ] Install command: ____________________
- [ ] Node version: ____________________

> The build command is the highest-value item here. Measured from the
> repository: `build:vercel` runs `DEPLOY_TARGET=vercel astro build`, and
> `astro.config.mjs:6` selects the adapter from that variable alone —
> `@astrojs/vercel` plus `cacheVercel()` when it equals `vercel`,
> `@astrojs/cloudflare` plus `cacheCloudflare()` otherwise. A build command of
> plain `npm run build` therefore produces the Cloudflare-target adapter. Check
> what it actually is rather than assuming the dashboard was configured to
> match.

> If the trigger is a Git push, note that this repository's `main` and
> `security/production-sync-final` carry **different content**. A push does not
> ship a branch until its content is merged.

---

## 8. Verification after any redeploy

Run from outside. Nothing below modifies anything.

- [ ] Site reachable

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://matjar.live
curl -sS -o /dev/null -w '%{http_code}\n' https://www.matjar.live
```

- [ ] Still Vercel, still the expected region

```sh
curl -sSI https://www.matjar.live | grep -i -E '^(server|x-vercel-id):'
```

- [ ] Storefront talks to the API — load the homepage and confirm products
      render. An empty catalogue points at `COD_SERVER_URL` or `STORE_API_KEY`
      rather than at the build itself
- [ ] Images render. If requests go to `api.matjar.live/images/…`, the R2
      custom domain is not in use for those images; that is the documented
      fallback in `cod-server/src/endpoints/images/public-url.ts`, not a fault
- [ ] Cross-check the deployed commit. The build log in the Vercel dashboard
      names the commit SHA — compare it to what you intended to ship

---

## Red flags

- Two projects claim `matjar.live` and `www.matjar.live` separately
- `COD_SERVER_URL` or `STORE_API_KEY` in Production but not Preview
- Build command is not the `build:vercel` target
- The dashboard reports a successful deploy that did not change the site
- `MEDIA_DOMAIN` set to a domain the API does not serve

---

## Record the outcome

Once filled in, the answers belong in this file. Until then they live only in
the operator's head, which is the situation this document exists to end.

| Item | Answer | Checked on | By |
|---|---|---|---|
| Account slug | | | |
| Project name | | | |
| Project ID | | | |
| Domains owned | | | |
| Variables present | | | |
| `MEDIA_DOMAIN` set? | | | |
| `media.matjar.live` serves | | | |
| Deploy trigger | | | |
| Build command | | | |
