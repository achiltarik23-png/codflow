/**
 * Unified Cloud resource values — single source of truth for CodFlow scripts.
 *
 * Reads <repo-root>/.env (gitignored) for the D1 database name, R2 bucket and
 * worker URLs. Every workspace imports this helper instead of hardcoding
 * resource values. Precedence: process.env > .env > default.
 *
 * Template keys live in <repo-root>/.env.example.
 *
 * Defaults are deliberately EMPTY except COD_SERVER_URL, which defaults to
 * localhost because local dev must work with no .env at all. Every other key
 * used to default to a placeholder name — codflow-os-db, codflow-images,
 * media.example.com — and that was worse than having no default: a .env written
 * against the old key convention (R2_BUCKET_NAME, MEDIA_DOMAIN) matched
 * nothing, so all five keys silently resolved to documentation examples. The
 * scripts ran, targeted the wrong database, and failed on a name nobody had
 * ever configured. An empty default cannot masquerade as a configuration.
 *
 * Two guards, because a silent wrong value is the failure mode that matters:
 *   - getCloudEnv({ require: [...] }) throws for keys the caller genuinely
 *     needs, so a missing value stops the script before it writes anywhere.
 *   - keys that still resolve to empty are reported on stderr, so an operator
 *     sees which values are guesses without having to trace the resolution.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULTS = {
  COD_ACCOUNT_ID: "",
  COD_DB_NAME: "",
  COD_R2_BUCKET_NAME: "",
  COD_SERVER_URL: "http://localhost:8787",
  COD_MEDIA_DOMAIN: "",
};

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the unified Cloud resource values.
 *
 * @param {object}   [options]
 * @param {string[]} [options.require] Keys this caller cannot work without.
 *   Missing ones raise instead of defaulting — use it wherever a wrong value
 *   would mean writing to the wrong Cloudflare resource (D1 migration, seed,
 *   R2 CORS, dashboard seeding).
 */
export function getCloudEnv({ require: required = [] } = {}) {
  const unknown = required.filter((key) => !(key in DEFAULTS));
  if (unknown.length > 0) {
    throw new Error(
      `cloud-env: require() received unknown key(s): ${unknown.join(", ")}. ` +
        `Known keys: ${Object.keys(DEFAULTS).join(", ")}`,
    );
  }

  let fileEnv = {};
  try {
    fileEnv = parseEnv(readFileSync(ROOT + ".env", "utf8"));
  } catch {
    // No .env file present — fall back to defaults below.
  }
  const merged = {};
  for (const key of Object.keys(DEFAULTS)) {
    const fromProcess = process.env[key];
    merged[key] = fromProcess ? fromProcess : fileEnv[key] ?? DEFAULTS[key];
  }

  const missing = required.filter((key) => !merged[key]);
  if (missing.length > 0) {
    throw new Error(
      `cloud-env: ${missing.join(", ")} not set. Define ${missing.length === 1 ? "it" : "them"} ` +
        `in <repo-root>/.env (see .env.example) or in the environment. These have no ` +
        `usable default: a guessed value writes to the wrong Cloudflare resource.`,
    );
  }

  // Not fatal — the caller may not need these at all (the storefront deploy only
  // reads serverUrl). Surfaced so a guess is never mistaken for a configured value.
  const unresolved = Object.keys(DEFAULTS).filter(
    (key) => !merged[key] && DEFAULTS[key] === "",
  );
  if (unresolved.length > 0) {
    console.warn(
      `[cloud-env] unresolved, defaulted to empty: ${unresolved.join(", ")} — ` +
        `set them in <repo-root>/.env (see .env.example) if this script needs them.`,
    );
  }

  return {
    accountId: merged.COD_ACCOUNT_ID,
    dbName: merged.COD_DB_NAME,
    bucketName: merged.COD_R2_BUCKET_NAME,
    serverUrl: merged.COD_SERVER_URL,
    mediaDomain: merged.COD_MEDIA_DOMAIN,
  };
}
