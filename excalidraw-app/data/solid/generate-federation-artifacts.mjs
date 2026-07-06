// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Regenerate the committed federation artifacts for the Excalidraw→Solid fork:
 *
 *   - `public/clientid.jsonld`  — the origin-aware Solid Client Identifier Document
 *                                  (the canonical PROD copy; regenerate per deploy origin).
 *   - `public/federation/registry.ttl` — the `fedreg:Registry` with the fork's
 *                                  `Active` membership.
 *
 * Origin is read from `EXCALIDRAW_SOLID_ORIGIN` (default the canonical prod origin).
 * The `client_id` in the JSON-LD ALWAYS equals the served URL byte-for-byte at that
 * origin — change the origin to redeploy elsewhere and re-run this script.
 *
 * Run: `node excalidraw-app/data/solid/generate-federation-artifacts.mjs`
 *
 * Imports the SAME pure builders the runtime + tests use (compiled on the fly is not
 * needed — these are plain ESM modules with no Excalidraw-type deps at the values level,
 * but the .ts source uses TS-only syntax, so this script re-implements the doc shape by
 * importing the package-level builders directly). To avoid a TS build step it calls the
 * published `@jeswr/federation-registry` for the registry and inlines the clientid shape
 * (kept in sync with `clientid-document.ts` by the federation contract test).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@jeswr/federation-registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const PUBLIC = resolve(REPO_ROOT, "public");

// The LIVE production origin (Vercel go-live 2026-07-06). `excalidraw.jeswr.org` is the
// eventual custom domain — regenerate the artifacts with EXCALIDRAW_SOLID_ORIGIN when it lands.
const CANONICAL_ORIGIN = "https://excalidraw-solid.vercel.app";
const origin = (process.env.EXCALIDRAW_SOLID_ORIGIN ?? CANONICAL_ORIGIN).replace(/\/$/, "");

const DRAWING_SECTOR = "https://w3id.org/jeswr/sectors/drawing#sector";
const DRAWING_SCENE_SHAPE = "https://w3id.org/jeswr/drawing#Scene";
// The maintainer / registry-operator WebID asserting the membership (set at go-live).
const ASSERTED_BY = "https://jeswr.org/#me";

function buildClientIdDocument(o) {
  return {
    "@context": [
      "https://www.w3.org/ns/solid/oidc-context.jsonld",
      {
        fedapp: "https://w3id.org/jeswr/fed#",
        acl: "http://www.w3.org/ns/auth/acl#",
        sectors: "https://w3id.org/jeswr/sectors/",
        App: "fedapp:App",
        sector: { "@id": "fedapp:sector", "@type": "@id" },
        access: { "@id": "fedapp:access", "@type": "@id", "@container": "@set" },
        consumes: { "@id": "fedapp:consumes", "@type": "@id", "@container": "@set" },
        produces: { "@id": "fedapp:produces", "@type": "@id", "@container": "@set" },
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

const clientId = `${origin}/clientid.jsonld`;

// 1. clientid.jsonld
const clientIdDoc = `${JSON.stringify(buildClientIdDocument(origin), null, 2)}\n`;
writeFileSync(resolve(PUBLIC, "clientid.jsonld"), clientIdDoc);

// 2. federation/registry.ttl
const registry = buildRegistry({
  id: `${origin}/federation/registry.ttl`,
  members: [
    {
      id: `${origin}/federation/registry.ttl#membership`,
      app: clientId,
      status: "Active",
      assertedBy: ASSERTED_BY,
    },
  ],
});
const registryTtl = await registry.toString();
mkdirSync(resolve(PUBLIC, "federation"), { recursive: true });
writeFileSync(resolve(PUBLIC, "federation", "registry.ttl"), registryTtl);

// eslint-disable-next-line no-console
console.log(`Wrote federation artifacts for origin ${origin}:`);
// eslint-disable-next-line no-console
console.log(`  public/clientid.jsonld         (client_id=${clientId})`);
// eslint-disable-next-line no-console
console.log(`  public/federation/registry.ttl (Active membership, assertedBy=${ASSERTED_BY})`);
