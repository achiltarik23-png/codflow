# Worker master secrets

`cod-server` runs on Cloudflare Workers as **`achil-codflow-server`**. Its
secrets live in the Cloudflare secret store for that Worker, readable by name
only — the API never returns a value.

**No secret value appears in this repository.** Not in Git, not in a `.env`,
not in `.dev.vars`, not in this file. If you find one committed anywhere, treat
it as compromised and rotate it.

```sh
npx wrangler secret list --config wrangler.toml   # names only
```

## The three secrets

| Name | Purpose | Consumed by |
|---|---|---|
| `BETTER_AUTH_SECRET` | Signs and verifies dashboard sessions. **Must be identical** to the copy on `cod-client-astro` — they share one auth D1. | `cod-client-astro/src/lib/auth/`, cod-server |
| `MCP_LOGIN_TICKET_SECRET` | Signs the short-lived tickets that bridge a dashboard sign-in to the MCP OAuth consent flow. **Must be identical** on both Workers. | `cod-server/src/mcp/authorize.ts` |
| `WEBHOOK_ENCRYPTION_KEY` | 32-byte hex master key (64 chars) that seals carrier webhook secrets in D1. | `cod-shared/lib/webhook-secret.ts` |

## `WEBHOOK_ENCRYPTION_KEY`

Created 2026-10-11.

### What it protects

`delivery_companies.webhook_secret` holds the HMAC key shared with a delivery
carrier. Unlike a bearer token, it cannot be hashed — verifying a delivery
means recomputing `HMAC(body, secret)`, and a hash cannot reproduce those
bytes. The value is therefore encrypted at rest with AES-256-GCM and stored in
the existing column as:

```
enc:v1:<base64 iv>:<base64 ciphertext+tag>
```

Rows written before this existed are still clear text and still read as such;
they upgrade the next time the secret is written.

### If the key is lost

Every stored webhook secret becomes **unreadable and unrecoverable**. There is
no backdoor and no reset path — the plaintext existed only in the carrier's
dashboard and in the row that is now ciphertext.

Consequences:

- signature verification fails for every carrier;
- today that lands in the "not configured" branch and events are accepted
  unverified, with an error-level log;
- **once signature verification is fail-closed** (a planned change), every
  merchant's webhook would start failing, and the carriers auto-disable a
  webhook after 7 consecutive failures — unsubscribing them.

Losing the key is therefore a production incident, not an inconvenience. Back
it up with the other master secrets, outside the repository.

### Restoring a lost key

There is no in-place restore — re-creating the key does not recover anything.
The procedure is to reseed the secrets from the carriers:

1. **ZR Express** — `POST /api/delivery-companies/:id/webhook/register` fetches
   a fresh signing secret from the carrier's endpoint API and seals it. No
   manual step.
2. **Yalidine** — copy the secret from the carrier's Webhooks Dashboard and
   `PATCH /api/delivery-companies/:id/webhook/secret`. Manual, per merchant.

Every webhook secret must be reseeded before fail-closed is enabled. Until
then, a lost key degrades to "verification unavailable" rather than an outage.

### Rotating the key deliberately

The key has no rotation path in code: writing a new one invalidates every
envelope already in D1. The safe order is the same as restoring — reseed every
carrier under the old key first, then replace the Worker secret, accepting
that each secret is re-fetched and re-sealed on its next write.

## Creating or replacing a secret

```sh
# value piped straight through: it never lands in a variable, a file or a
# command line
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  | npx wrangler secret put WEBHOOK_ENCRYPTION_KEY --config wrangler.toml
```

`wrangler secret put` creates a new Worker version and deploys it. Confirm with
`wrangler secret list` (names only).

Do **not** pass `--env production`: `achil-codflow-server-production` does not
exist on the account, so that flag would create a second Worker with none of
these secrets set and break authentication.

## Related

- [`../STOREFRONT_DEPLOYMENT.md`](../STOREFRONT_DEPLOYMENT.md) — Vercel is the
  storefront target; its variables are Vercel-side, not Worker-side.
- [`VERCEL_PRODUCTION.md`](VERCEL_PRODUCTION.md) — Vercel storefront
  deployment and the `STORE_API_KEY` rotation procedure.