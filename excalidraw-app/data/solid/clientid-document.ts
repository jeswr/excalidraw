// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The origin-aware Solid Client Identifier Document for the Excalidraw→Solid fork.
 *
 * THE INVARIANT (Solid-OIDC, a HARDENING RULE here): the served `client_id` MUST equal
 * the served URL byte-for-byte at WHATEVER origin the app deploys to. A hard-coded
 * origin breaks Solid login on local / preview / fork / alt-prod deploys, because the
 * login wiring computes `/clientid.jsonld` + `/callback.html` from the CURRENT origin —
 * a document baked with a different origin can never match. So every origin-bearing
 * field is derived from a single `origin` argument, and the served document is generated
 * for the deploy origin (the static `public/clientid.jsonld` is the canonical prod copy;
 * an origin-aware server route / build step should regenerate it for any other origin).
 *
 * This module is PURE (no I/O) so it is shared by the build/serve path AND the federation
 * contract tests, and is trivially unit-testable for the byte-for-byte origin contract.
 */

/** The drawing sector + scene shape IRIs the fork registers under (origin-independent). */
export const DRAWING_SECTOR = "https://w3id.org/jeswr/sectors/drawing#sector";
export const DRAWING_SCENE_SHAPE = "https://w3id.org/jeswr/drawing#Scene";

/**
 * Normalise an origin to a bare `scheme://host[:port]` with NO trailing slash, so
 * `${origin}/clientid.jsonld` is well-formed regardless of how it was passed. Throws on
 * a non-http(s) / unparseable origin (fail-closed — a bad origin must not yield a
 * malformed `client_id`).
 */
export function normaliseOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`clientid origin must be http(s) (got ${origin})`);
  }
  return u.origin;
}

/**
 * Build the fork's Client Identifier Document for `origin`. Every origin-bearing field
 * (`client_id`, `client_uri`, `logo_uri`, `redirect_uris`) is derived from the SAME
 * `origin`, so the served `client_id` equals the served URL byte-for-byte at that origin.
 * The `@context`, federation block, and OAuth metadata are origin-independent.
 *
 * The `fedapp:App` block self-describes the app for the federation: it produces
 * `draw:Scene` resources in the drawing sector and needs WAC Read/Write/Control over
 * the user's `…/drawings/` container (owner-private).
 */
export function buildClientIdDocument(origin: string): Record<string, unknown> {
  const o = normaliseOrigin(origin);
  return {
    "@context": [
      "https://www.w3.org/ns/solid/oidc-context.jsonld",
      {
        fedapp: "https://w3id.org/jeswr/fed#",
        acl: "http://www.w3.org/ns/auth/acl#",
        sectors: "https://w3id.org/jeswr/sectors/",
        App: "fedapp:App",
        sector: { "@id": "fedapp:sector", "@type": "@id" },
        access: {
          "@id": "fedapp:access",
          "@type": "@id",
          "@container": "@set",
        },
        consumes: {
          "@id": "fedapp:consumes",
          "@type": "@id",
          "@container": "@set",
        },
        produces: {
          "@id": "fedapp:produces",
          "@type": "@id",
          "@container": "@set",
        },
      },
    ],
    client_id: `${o}/clientid.jsonld`,
    client_name: "Excalidraw (Solid edition)",
    client_uri: `${o}/`,
    logo_uri: `${o}/favicon.ico`,
    redirect_uris: [`${o}/`, `${o}/callback.html`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "openid profile offline_access webid",
    token_endpoint_auth_method: "none",

    "@type": "App",
    sector: DRAWING_SECTOR,
    access: ["acl:Read", "acl:Write", "acl:Control"],
    produces: [DRAWING_SCENE_SHAPE],
    consumes: [DRAWING_SCENE_SHAPE],
  };
}

/** Serialise the document as canonical pretty JSON (the bytes the route/file serves). */
export function serializeClientIdDocument(origin: string): string {
  return `${JSON.stringify(buildClientIdDocument(origin), null, 2)}\n`;
}
