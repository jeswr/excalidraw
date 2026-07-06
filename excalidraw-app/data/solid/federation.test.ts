// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Federation-registration contract tests — verify the fork's committed federation
// artifacts (the clientid.jsonld fedapp block + the fedreg:Membership registry) are
// well-formed and agree with each other. These lock the federation IRIs so a refactor
// cannot silently break self-registration / membership.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listMembers } from "@jeswr/federation-registry";
import { describe, expect, it } from "vitest";

import {
  buildClientIdDocument,
  DRAWING_SCENE_SHAPE,
  DRAWING_SECTOR,
  normaliseOrigin,
} from "./clientid-document";
import { MAINTAINER_ASSERTED_BY, serializeForkRegistry } from "./federation";

// The LIVE production origin (Vercel go-live 2026-07-06). `excalidraw.jeswr.org` is the
// eventual custom domain - regenerate the artifacts + this constant when it lands.
const CANONICAL_ORIGIN = "https://excalidraw-solid.vercel.app";
const CLIENT_ID = `${CANONICAL_ORIGIN}/clientid.jsonld`;

// vitest runs from the repo root (the monorepo working dir); the committed federation
// artifacts live in the root `public/` (Excalidraw's `vite` publicDir).
function readPublic(rel: string): string {
  return readFileSync(resolve(process.cwd(), "public", rel), "utf8");
}

describe("clientid.jsonld fedapp self-registration (origin-aware template)", () => {
  const doc = buildClientIdDocument(CANONICAL_ORIGIN) as Record<string, any>;

  it("declares an fedapp:App in the drawing sector", () => {
    expect(doc["@type"]).toBe("App");
    expect(doc.sector).toBe(DRAWING_SECTOR);
    expect(DRAWING_SECTOR).toBe(
      "https://w3id.org/jeswr/sectors/drawing#sector",
    );
  });

  it("client_id equals its own served URL (Solid-OIDC rule)", () => {
    expect(doc.client_id).toBe(CLIENT_ID);
  });

  it("requests the WAC modes the fork needs (Read/Write/Control for owner-private boards)", () => {
    expect(doc.access).toContain("acl:Read");
    expect(doc.access).toContain("acl:Write");
    expect(doc.access).toContain("acl:Control");
  });

  it("produces the draw:Scene shape", () => {
    expect(doc.produces).toContain(DRAWING_SCENE_SHAPE);
    expect(DRAWING_SCENE_SHAPE).toBe("https://w3id.org/jeswr/drawing#Scene");
  });

  it("lists the OAuth callback in redirect_uris and has the webid scope", () => {
    expect(doc.redirect_uris).toContain(`${CANONICAL_ORIGIN}/callback.html`);
    expect(doc.scope.split(" ")).toContain("webid");
  });

  it("is ORIGIN-AWARE: the served client_id equals the served URL byte-for-byte at any origin", () => {
    for (const origin of [
      "https://excalidraw.jeswr.org",
      "http://localhost:3000",
      "https://excalidraw-preview.vercel.app",
    ]) {
      const d = buildClientIdDocument(origin) as Record<string, any>;
      expect(d.client_id).toBe(`${origin}/clientid.jsonld`);
      expect(d.client_uri).toBe(`${origin}/`);
      expect(d.redirect_uris).toContain(`${origin}/`);
      expect(d.redirect_uris).toContain(`${origin}/callback.html`);
    }
  });

  it("rejects a non-http(s) origin (fail-closed)", () => {
    expect(() => normaliseOrigin("ftp://evil.example")).toThrow(/http\(s\)/);
  });
});

describe("committed public/clientid.jsonld matches the template at the canonical origin", () => {
  it("the served bytes name themselves at the canonical origin", () => {
    const served = JSON.parse(readPublic("clientid.jsonld")) as Record<
      string,
      any
    >;
    expect(served.client_id).toBe(CLIENT_ID);
    expect(served["@type"]).toBe("App");
    expect(served.sector).toBe(DRAWING_SECTOR);
    expect(served.produces).toContain(DRAWING_SCENE_SHAPE);
  });
});

describe("fedreg:Membership registry", () => {
  it("builds an Active membership for the fork client_id", async () => {
    const ttl = await serializeForkRegistry({
      registryId: `${CANONICAL_ORIGIN}/federation/registry.ttl`,
      clientId: CLIENT_ID,
      membershipId: `${CANONICAL_ORIGIN}/federation/registry.ttl#membership`,
    });
    const members = await listMembers(
      `${CANONICAL_ORIGIN}/federation/registry.ttl`,
      {
        body: ttl,
      },
    );
    expect(members).toHaveLength(1);
    expect(members[0].membership?.app).toBe(CLIENT_ID);
    expect(members[0].membership?.status).toBe("Active");
    expect(members[0].membership?.assertedBy).toContain(MAINTAINER_ASSERTED_BY);
  });

  it("the committed public/federation/registry.ttl verifies clean with an Active membership", async () => {
    const ttl = readPublic("federation/registry.ttl");
    const members = await listMembers(
      `${CANONICAL_ORIGIN}/federation/registry.ttl`,
      {
        body: ttl,
      },
    );
    expect(members).toHaveLength(1);
    expect(members[0].membership?.app).toBe(CLIENT_ID);
    expect(members[0].membership?.status).toBe("Active");
  });
});
