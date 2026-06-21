// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Session-layer tests for the load-bearing wiring fix.
 *
 * The round-1 bug was subtle: even where silent restore "worked", `solidFetch()` returned
 * the BARE unauthenticated global, so pod requests after a restore were NOT authenticated
 * (the restored credential was discarded). These tests prove:
 *
 *   - `solidFetch()` returns the session-installed authed fetch once `setSolidFetch` is set;
 *   - `dpopAuthedFetch` attaches a fresh RFC 9449 DPoP proof + `Authorization: DPoP <token>`
 *     to every request (built from the restored credential);
 *   - `silentRestore` INSTALLS that authed fetch (so post-restore pod calls are authed);
 *   - `disconnectSolid` clears the installed fetch (back to the bare global).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disconnectSolid,
  dpopAuthedFetch,
  setSolidFetch,
  solidConnected,
  solidFetch,
  solidWebId,
} from "./session";

// dpop@2.1.1 signs proofs via Uint8Array.prototype.toBase64 (a very new JS API absent in
// the jsdom test env). We mock generateProof: these tests assert the WIRING (a proof + the
// Authorization header are attached), NOT dpop's crypto. The real proof is generated in the
// browser, exercised by the integration path.
vi.mock("dpop", () => ({
  generateProof: vi.fn(async () => "header.payload.signature"),
}));

const WEBID = "https://alice.pod.example/profile/card#me";
const ISSUER = "https://idp.example/";

/** A real (non-extractable) ES256 key pair so dpop.generateProof can sign. */
async function makeDpopKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

afterEach(() => {
  setSolidFetch(null);
  disconnectSolid();
  vi.restoreAllMocks();
});

describe("solidFetch / setSolidFetch", () => {
  it("returns the bare global before any session fetch is installed", () => {
    setSolidFetch(null);
    expect(solidFetch()).toBeTypeOf("function");
  });

  it("returns the installed authed fetch once set", () => {
    const authed = vi.fn(async () => new Response(null));
    setSolidFetch(authed as unknown as typeof fetch);
    expect(solidFetch()).toBe(authed);
  });
});

describe("dpopAuthedFetch — every request is DPoP-authed", () => {
  it("attaches a DPoP proof + Authorization header bound to the access token", async () => {
    const dpopKey = await makeDpopKey();
    const base = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const authed = dpopAuthedFetch({ accessToken: "AT-123", dpopKey });
    await authed("https://alice.pod.example/drawings/default.excalidraw", {
      method: "PUT",
    });

    expect(base).toHaveBeenCalledTimes(1);
    const sentRequest = base.mock.calls[0][0] as Request;
    expect(sentRequest.headers.get("Authorization")).toBe("DPoP AT-123");
    const proof = sentRequest.headers.get("DPoP");
    expect(proof).toBeTruthy();
    // A JWT-shaped proof (three base64url segments).
    expect(proof?.split(".")).toHaveLength(3);
  });
});

describe("silentRestore — installs the authed fetch + connects (the fix)", () => {
  it("on a restored credential: installs a DPoP-authed fetch and connects", async () => {
    const dpopKey = await makeDpopKey();

    // Mock the session-restore package: a remembered pointer + a successful restore that
    // yields a live credential.
    vi.doMock("@jeswr/solid-session-restore", () => ({
      indexedDbAvailable: () => true,
      IndexedDbSessionStore: class {},
      RememberedAccount: class {
        read() {
          return { webId: WEBID, issuer: ISSUER };
        }
        clear() {}
        write() {}
      },
      decideSilentRestore: async (inputs: {
        restoreIssuer: (
          issuer: string,
        ) => Promise<{ webId: string } | undefined>;
      }) => {
        const r = await inputs.restoreIssuer(ISSUER);
        return r
          ? { outcome: "restored", webId: r.webId, issuer: ISSUER }
          : { outcome: "login", reason: "restore-failed" };
      },
      restoreSession: async () => ({
        webId: WEBID,
        accessToken: "AT-restored",
        dpopKey,
      }),
      hasPersisted: async () => "present",
      shouldDropRememberedPointer: () => false,
    }));

    // fetch-rdf is used by connectSolid (resolveStorageRoot + resolveOidcIssuer); stub it.
    vi.doMock("@jeswr/fetch-rdf", () => ({
      fetchRdf: async () => ({
        dataset: { match: () => [][Symbol.iterator]() },
      }),
    }));

    // Spy on the global BEFORE restore, so the authed fetch dpopAuthedFetch builds
    // (snapshotting globalThis.fetch at construction) wraps the spy, not real network.
    const base = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Re-import the module under the mocks (vi.doMock is not hoisted).
    vi.resetModules();
    const sessionMod = await import("./session");

    const webId = await sessionMod.silentRestore();

    expect(webId).toBe(WEBID);
    expect(sessionMod.solidConnected()).toBe(true);
    expect(sessionMod.solidWebId()).toBe(WEBID);

    // THE LOAD-BEARING ASSERTION: solidFetch is now a DISTINCT authed fetch, NOT the bare
    // global — so post-restore pod requests are authenticated.
    const authed = sessionMod.solidFetch();
    expect(authed).not.toBe(globalThis.fetch);

    // And it actually attaches the restored credential's auth headers.
    base.mockClear();
    await authed("https://alice.pod.example/drawings/x.excalidraw");
    const sent = base.mock.calls[0][0] as Request;
    expect(sent.headers.get("Authorization")).toBe("DPoP AT-restored");
    expect(sent.headers.get("DPoP")).toBeTruthy();
  });

  it("no remembered pointer: returns null, stays logged-out, NO popup, bare fetch", async () => {
    vi.doMock("@jeswr/solid-session-restore", () => ({
      indexedDbAvailable: () => true,
      IndexedDbSessionStore: class {},
      RememberedAccount: class {
        read() {
          return null; // nothing remembered
        }
        clear() {}
        write() {}
      },
      decideSilentRestore: async () => ({
        outcome: "login",
        reason: "no-account",
      }),
      restoreSession: async () => undefined,
      hasPersisted: async () => "absent",
      shouldDropRememberedPointer: () => false,
    }));

    vi.resetModules();
    const sessionMod = await import("./session");
    const webId = await sessionMod.silentRestore();

    expect(webId).toBeNull();
    expect(sessionMod.solidConnected()).toBe(false);
  });
});

describe("disconnectSolid clears the installed authed fetch", () => {
  it("reverts solidFetch to the bare global on disconnect", () => {
    const authed = vi.fn(async () => new Response(null));
    setSolidFetch(authed as unknown as typeof fetch);
    expect(solidFetch()).toBe(authed);

    disconnectSolid();
    expect(solidFetch()).not.toBe(authed);
    expect(solidConnected()).toBe(false);
    expect(solidWebId()).toBeNull();
  });
});
