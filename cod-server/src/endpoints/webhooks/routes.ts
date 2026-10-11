/**
 * Webhook Routes
 *
 * Public router — NO auth middleware anywhere in this file.
 * Authentication is handled internally by each handler via signature
 * verification (Svix HMAC-SHA256 for ZR Express).
 *
 * Mount order in index.ts:
 *   app.route("/webhooks", webhooksRouter)  ← BEFORE app.use("/api/*", authMiddleware)
 *
 * Built with defineRoute() — the standard route-builder pattern.
 *
 * Deliberately NO request-body validation on the event-delivery routes:
 * handlers must read the RAW body (c.req.text()) before any JSON parsing
 * because Svix signatures verify raw bytes — framework parsing here would
 * break that contract. Payload shapes are documented in the route
 * descriptions and the handlers enforce their own specific error codes.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { defineRoute } from "@/lib/route-builder";
import {
  handleYalidineChallenge,
  handleYalidineWebhook,
  handleZrWebhook,
} from "./handlers";
import { webhookRateLimit } from "./webhook-rate-limit";

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});

// ─── Response schemas ─────────────────────────────────────────────────────────

const receivedResponse = {
  description: "Event received (always 200 — carriers retry on non-200)",
  content: jsonContent(
    z.object({
      received: z.boolean().openapi({ example: true }),
    })
  ),
};

const webhookErrorResponse = (code: string, category: string, description: string) => ({
  description,
  content: jsonContent(
    z.object({
      error: z.string(),
      code: z.string().openapi({ example: code }),
      category: z.string().openapi({ example: category }),
      context: z.record(z.string(), z.unknown()).optional(),
    })
  ),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

const yalidineChallengeRoute = defineRoute({
  method: "get",
  path: "/yalidine",
  auth: "public",
  tags: ["Webhooks"],
  summary: "Yalidine CRC challenge",
  description:
    "Yalidine sends a GET request with ?subscribe=…&crc_token=<value> to validate the endpoint " +
    "at creation, edit, and periodically. The endpoint echoes the crc_token as plain text. " +
    "If this fails, Yalidine disables the webhook automatically.",
  operationId: "yalidineChallenge",
  query: z.object({
    subscribe: z.string().optional().openapi({
      description: "Sent by Yalidine to initiate the CRC challenge",
    }),
    crc_token: z.string().optional().openapi({
      description: "Token echoed back in the (plain-text) response body",
    }),
  }),
  responses: {
    // Documented contract: crc_token echoed as text/plain. Without challenge
    // params the legacy handler answers a tiny {ok:true} JSON ack instead —
    // the dual return predates typed routes.
    200: {
      description: "CRC token echoed as plain text",
      content: {
        "text/plain": {
          schema: z.string().openapi({ example: "abc123token" }),
        },
      },
    },
  },
  handler: handleYalidineChallenge,
});

const yalidineWebhookRoute = defineRoute({
  method: "post",
  path: "/yalidine",
  auth: "public",
  tags: ["Webhooks"],
  summary: "Yalidine event delivery",
  description: `Receives webhook event batches from Yalidine. One event type per request, multiple events per batch. Each event carries its own idempotency key (\`event_id\`). Always returns 200 — errors are logged internally.

**Signature verification:** when the company's webhook secret is stored, the \`X-Yalidine-Signature\` header (HMAC-SHA256 of the raw body, hex) is verified and mismatching deliveries are rejected with \`400 INVALID_WEBHOOK_PAYLOAD\`. Without a stored secret the endpoint fail-opens (events accepted unverified, warning logged).

**Payload:** \`{ type: "parcel_created" | "parcel_edited" | "parcel_deleted" | "parcel_status_updated" | "parcel_payment_updated", events: [{ event_id, occurred_at, data }] }\`

Invalid payloads are rejected with \`400 INVALID_WEBHOOK_PAYLOAD\`; processing failures surface as \`502 EXTERNAL_API_FAILURE\`.`,
  operationId: "yalidineWebhook",
  headers: z.object({
    "X-Yalidine-Signature": z.string().optional().openapi({
      description: "HMAC-SHA256 of the raw request body, keyed with the webhook secret (hex). Required when a secret is stored.",
    }),
  }),
  responses: {
    200: receivedResponse,
    400: webhookErrorResponse(
      "INVALID_WEBHOOK_PAYLOAD",
      "VALIDATION",
      "Invalid webhook payload or signature (INVALID_WEBHOOK_PAYLOAD)"
    ),
    502: webhookErrorResponse(
      "EXTERNAL_API_FAILURE",
      "SYSTEM",
      "Webhook processing failed (EXTERNAL_API_FAILURE)"
    ),
    429: webhookErrorResponse(
      "WEBHOOK_RATE_LIMITED",
      "SYSTEM",
      "Too many deliveries from this source — retry after the Retry-After header. The limit is per carrier per client IP per minute and fails open when the rate-limit store is unavailable"
    ),
  },
  handler: handleYalidineWebhook,
});

const zrWebhookRoute = defineRoute({
  method: "post",
  path: "/zr_express",
  auth: "public",
  tags: ["Webhooks"],
  summary: "ZR Express event delivery",
  description: `Receives webhook events from ZR Express via Svix. Signature is verified using HMAC-SHA256 with the stored whsec_ secret over the RAW request bytes. Idempotency key is the \`svix-id\` header. Always returns 200.

**Payload:** \`{ eventType: "parcel.state.updated" | "parcel.state.situation.created" | "parcel.isReturn.updated", occurredAt, data: ParcelWebhookDto }\`

Signature/payload failures are rejected with \`400 INVALID_WEBHOOK_PAYLOAD\`; processing failures surface as \`502 EXTERNAL_API_FAILURE\`.`,
  operationId: "zrExpressWebhook",
  headers: z.object({
    "svix-id": z.string().openapi({ description: "Svix idempotency key" }),
    "svix-timestamp": z.string().openapi({ description: "Svix signed timestamp" }),
    "svix-signature": z.string().openapi({ description: "Svix HMAC-SHA256 signature" }),
  }),
  responses: {
    200: receivedResponse,
    400: webhookErrorResponse(
      "INVALID_WEBHOOK_PAYLOAD",
      "VALIDATION",
      "Invalid webhook payload or signature (INVALID_WEBHOOK_PAYLOAD)"
    ),
    502: webhookErrorResponse(
      "EXTERNAL_API_FAILURE",
      "SYSTEM",
      "Webhook processing failed (EXTERNAL_API_FAILURE)"
    ),
    429: webhookErrorResponse(
      "WEBHOOK_RATE_LIMITED",
      "SYSTEM",
      "Too many deliveries from this source — retry after the Retry-After header. The limit is per carrier per client IP per minute and fails open when the rate-limit store is unavailable"
    ),
    503: webhookErrorResponse(
      "SERVICE_UNAVAILABLE",
      "SYSTEM",
      "Signature verification is not configured for this carrier (ZR Express only; Yalidine still accepts unverified deliveries)"
    ),
  },
  handler: handleZrWebhook,
});

// ─── Router ───────────────────────────────────────────────────────────────────

const webhooksRouter = new OpenAPIHono<AppContext>();

// Ingress rate limit on the delivery routes, ahead of every handler. Mounted as
// middleware rather than inside a handler so a flooded route costs one KV read
// instead of a D1 query. Per-carrier budgets, fail-open on KV trouble — see
// webhook-rate-limit.ts for why the threshold is an arbitrary first value.
webhooksRouter.use("/yalidine", webhookRateLimit("yalidine"));
webhooksRouter.use("/zr_express", webhookRateLimit("zr_express"));

webhooksRouter.openapi(yalidineChallengeRoute.route, yalidineChallengeRoute.handler);
webhooksRouter.openapi(yalidineWebhookRoute.route, yalidineWebhookRoute.handler);
webhooksRouter.openapi(zrWebhookRoute.route, zrWebhookRoute.handler);

export default webhooksRouter;
