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

// --- SECURITY: resolveStorageRoot must PARSE `pim:storage`, never raw-string `endsWith` ---
describe("resolveStorageRoot — raw-string endsWith bypass fix", () => {
  /** A fake fetch-rdf dataset yielding one `pim:storage` NamedNode quad. */
  function mockFetchRdfWithStorage(storageValue: string | null) {
    vi.doMock("@jeswr/fetch-rdf", () => ({
      fetchRdf: async () => ({
        dataset: {
          match: () =>
            (storageValue === null
              ? []
              : [
                  {
                    predicate: {
                      value: "http://www.w3.org/ns/pim/space#storage",
                    },
                    object: { termType: "NamedNode", value: storageValue },
                  },
                ])[Symbol.iterator](),
        },
      }),
    }));
  }

  it("a clean container root is returned unchanged", async () => {
    mockFetchRdfWithStorage("https://alice.pod.example/storage/");
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    expect(root).toBe("https://alice.pod.example/storage/");
  });

  it("a root missing the trailing slash is normalised to end with '/'", async () => {
    mockFetchRdfWithStorage("https://alice.pod.example/storage");
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    expect(root).toBe("https://alice.pod.example/storage/");
  });

  it("a query-smuggled '/' (?q=/) does NOT pass the raw-string endsWith check — falls back to the WebID origin root", async () => {
    mockFetchRdfWithStorage("https://evil.example/x?q=/");
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    // The malformed value is rejected outright (never trusted, never stripped-and-used);
    // the caller falls through to the WebID's own origin root.
    expect(root).toBe("https://alice.pod.example/");
    expect(root).not.toContain("evil.example");
    expect(root).not.toContain("?");
  });

  it("a fragment-smuggled '/' (#/) does NOT pass the raw-string endsWith check — falls back to the WebID origin root", async () => {
    mockFetchRdfWithStorage("https://evil.example/x#/");
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    expect(root).toBe("https://alice.pod.example/");
    expect(root).not.toContain("evil.example");
    expect(root).not.toContain("#");
  });

  it("an unparseable pim:storage value falls back to the WebID origin root", async () => {
    mockFetchRdfWithStorage("not a url at all");
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    expect(root).toBe("https://alice.pod.example/");
  });

  it("no pim:storage advertised falls back to the WebID origin root", async () => {
    mockFetchRdfWithStorage(null);
    vi.resetModules();
    const { resolveStorageRoot: fn } = await import("./session");
    const root = await fn(WEBID, globalThis.fetch);
    expect(root).toBe("https://alice.pod.example/");
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

// --- ROUND-3 HIGH: interactiveLogin uses a SCOPED fetch, never patches the global -------
describe("interactiveLogin — SCOPED fetch, globalThis.fetch never patched (HIGH fix)", () => {
  /**
   * A fake ReactiveFetchManager mirroring the real one's contract: `fetch` is a SCOPED
   * accessor (does the 401→upgrade reactive logic against globalThis.fetch WITHOUT touching
   * it), `registerGlobally()` would patch the global. The test asserts interactiveLogin uses
   * `fetch` and NEVER calls `registerGlobally()`.
   */
  let registerGloballyCalls = 0;
  let managerInstances = 0;

  function setupInteractiveMocks(): void {
    registerGloballyCalls = 0;
    managerInstances = 0;

    class FakeManager {
      #global: typeof globalThis.fetch;
      constructor(_providers: unknown) {
        managerInstances += 1;
        this.#global = globalThis.fetch;
      }
      registerGlobally() {
        registerGloballyCalls += 1;
        // The real one does `globalThis.fetch = this.fetch`. We DELIBERATELY do that here
        // so the test would FAIL (global mutated) if interactiveLogin ever called this.
        globalThis.fetch = this.fetch;
      }
      get fetch(): typeof globalThis.fetch {
        // A scoped reactive fetch: on a 401 it would attach a token; here it just delegates
        // (the popup/upgrade path is out of scope — we only assert the global isn't patched).
        const scoped = (async (input: RequestInfo | URL, init?: RequestInit) =>
          this.#global(input as RequestInfo, init)) as typeof globalThis.fetch;
        return scoped;
      }
    }

    // A valid custom-element class (a real HTMLElement subclass) so jsdom's
    // customElements.define + document.createElement("authorization-code-flow") succeed.
    // getCode is present but never invoked (connect's profile read is stubbed to not 401).
    class FakeAuthCodeFlow extends HTMLElement {
      async getCode(_uri: URL, _signal: AbortSignal): Promise<string> {
        return "unused-code";
      }
    }

    vi.doMock("@solid/reactive-authentication", () => ({
      ReactiveFetchManager: FakeManager,
      AuthorizationCodeFlow: FakeAuthCodeFlow,
    }));

    // The WebID dialog + token provider — interactiveLogin imports these dynamically. The
    // provider is constructed but never exercised (connect's profile read is stubbed below).
    vi.doMock("./webid-token-provider.js", () => ({
      WebIdDPoPTokenProvider: class {},
      promptWebIdDialog: async () => WEBID,
    }));

    // connectSolid → resolveStorageRoot + resolveOidcIssuer dereference the profile; stub.
    vi.doMock("@jeswr/fetch-rdf", () => ({
      fetchRdf: async () => ({
        dataset: { match: () => [][Symbol.iterator]() },
      }),
    }));

    // interactiveLogin's idempotent-connect disconnectSolid() + connectSolid() touch the
    // session-restore package (clear/write the remembered pointer); stub it so the test
    // doesn't load the real package or leave an unhandled rejection.
    vi.doMock("@jeswr/solid-session-restore", () => ({
      RememberedAccount: class {
        read() {
          return null;
        }
        clear() {}
        write() {}
      },
    }));

    // jsdom provides window/document; ensure customElements exists for the define() guard.
    if (typeof customElements === "undefined") {
      // @ts-expect-error — minimal shim for the non-DOM-complete envs.
      globalThis.customElements = { get: () => undefined, define: () => {} };
    }
  }

  it("after connect→disconnect, globalThis.fetch is the ORIGINAL (identity), no Solid interception", async () => {
    setupInteractiveMocks();
    const original = globalThis.fetch;

    vi.resetModules();
    const sessionMod = await import("./session");

    await sessionMod.interactiveLogin(WEBID);

    // The scoped manager fetch was installed as the SESSION fetch (solidFetch), and it is
    // NOT the bare global (it does the reactive upgrade for pod calls)…
    expect(sessionMod.solidFetch()).not.toBe(original);
    // …but the GLOBAL was never patched.
    expect(registerGloballyCalls).toBe(0);
    expect(globalThis.fetch).toBe(original);

    sessionMod.disconnectSolid();

    // After disconnect: the global is STILL the original (never patched, nothing to restore),
    // and solidFetch reverts to the bare global → no Solid provider intercepts anything.
    expect(globalThis.fetch).toBe(original);
    expect(sessionMod.solidConnected()).toBe(false);
  });

  it("a non-pod fetch is NOT auth-upgraded after connect→disconnect", async () => {
    setupInteractiveMocks();
    // The spy IS globalThis.fetch for the duration of the test; the manager constructor
    // snapshots it. If interactiveLogin patched the global, this spy would be replaced.
    const baseSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const spiedGlobal = globalThis.fetch;

    vi.resetModules();
    const sessionMod = await import("./session");
    await sessionMod.interactiveLogin(WEBID);
    sessionMod.disconnectSolid();

    // The global is STILL the spy — interactiveLogin never replaced it (no registerGlobally).
    expect(globalThis.fetch).toBe(spiedGlobal);
    expect(registerGloballyCalls).toBe(0);

    // An UNRELATED app fetch after disconnect goes straight through the bare global with no
    // Authorization/DPoP header attached (the Solid provider does not intercept it).
    baseSpy.mockClear();
    await globalThis.fetch("https://unrelated.example/api/thing");
    const sent = baseSpy.mock.calls.at(-1)?.[0];
    const req =
      sent instanceof Request ? sent : new Request(sent as RequestInfo);
    expect(req.headers.get("Authorization")).toBeNull();
    expect(req.headers.get("DPoP")).toBeNull();
  });

  it("two connects do NOT stack global managers (idempotent connect)", async () => {
    setupInteractiveMocks();
    const original = globalThis.fetch;

    vi.resetModules();
    const sessionMod = await import("./session");

    await sessionMod.interactiveLogin(WEBID);
    await sessionMod.interactiveLogin(WEBID);

    // registerGlobally() was NEVER called (so nothing was stacked onto the global), and the
    // global is still the original after two connects.
    expect(registerGloballyCalls).toBe(0);
    expect(globalThis.fetch).toBe(original);
    // Two managers were constructed (one per connect) but neither touched the global; the
    // second connect first cleared the first via the idempotent disconnect.
    expect(managerInstances).toBe(2);
    expect(sessionMod.solidConnected()).toBe(true);

    sessionMod.disconnectSolid();
    expect(globalThis.fetch).toBe(original);
  });
});
