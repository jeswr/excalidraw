// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import * as session from "./session";
import {
  DEFAULT_BOARD,
  flushPodScene,
  hasPendingPodScene,
  loadPodScene,
  podStoreReady,
  savePodScene,
  teardownPodStore,
  wirePodStore,
} from "./controller";

// We control the session module so the controller's "connected" gate is deterministic.
vi.mock("./session", () => {
  let connected = false;
  let container: string | null = null;
  let webId: string | null = null;
  const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
  return {
    solidConnected: () => connected,
    drawingsContainer: () => container,
    solidWebId: () => webId,
    solidFetch: () => fetchFn as unknown as typeof fetch,
    // test helpers (not part of the real module API)
    __set: (c: boolean, cont: string | null, w: string | null) => {
      connected = c;
      container = cont;
      webId = w;
    },
    __fetch: fetchFn,
  };
});

const CONTAINER = "https://alice.pod.example/drawings/";
const WEBID = "https://alice.pod.example/profile/card#me";

const serialize = () =>
  JSON.stringify({ type: "excalidraw", version: 2, elements: [] });

const setSession = (
  connected: boolean,
  container: string | null,
  webId: string | null,
) =>
  (session as unknown as { __set: (...a: unknown[]) => void }).__set(
    connected,
    container,
    webId,
  );

const sessionFetch = () =>
  (session as unknown as { __fetch: ReturnType<typeof vi.fn> }).__fetch;

beforeEach(() => {
  vi.useFakeTimers();
  setSession(false, null, null);
  sessionFetch().mockClear();
  sessionFetch().mockImplementation(
    async () => new Response(null, { status: 201 }),
  );
  teardownPodStore();
});

afterEach(() => {
  vi.useRealTimers();
  teardownPodStore();
});

describe("controller wiring", () => {
  it("does NOT wire a store when no pod is connected", () => {
    setSession(false, null, null);
    wirePodStore(serialize);
    expect(podStoreReady()).toBe(false);
  });

  it("wires a store when connected", () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    expect(podStoreReady()).toBe(true);
  });
});

describe("savePodScene (debounced, fail-soft)", () => {
  it("is a no-op when no pod is connected (existing localStorage path untouched)", () => {
    setSession(false, null, null);
    wirePodStore(serialize);
    savePodScene([], {}, {});
    vi.runAllTimers();
    expect(sessionFetch()).not.toHaveBeenCalled();
  });

  it("coalesces a burst of saves into a single debounced pod write", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const el = { id: "a", type: "rectangle" } as unknown as ExcalidrawElement;
    savePodScene([el], { viewBackgroundColor: "#111" }, {});
    savePodScene([el], { viewBackgroundColor: "#222" }, {});
    savePodScene([el], { viewBackgroundColor: "#333" }, {});

    await vi.runAllTimersAsync();

    // Exactly one container .acl PUT (memoised) + one scene body PUT (last write wins).
    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    const sceneWrites = calls.filter(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    );
    expect(sceneWrites).toHaveLength(1);
  });

  it("never throws to the editor on a pod write failure", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    sessionFetch().mockImplementation(
      async () => new Response("boom", { status: 500 }),
    );
    expect(() => savePodScene([], {}, {})).not.toThrow();
    // The debounced save runs and swallows the 500 — the editor never sees an error.
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });
});

describe("flushPodScene / loadPodScene", () => {
  it("flush is a no-op when nothing pending / no pod", async () => {
    setSession(false, null, null);
    wirePodStore(serialize);
    await expect(flushPodScene()).resolves.toBeUndefined();
  });

  it("loadPodScene returns undefined when not connected", async () => {
    setSession(false, null, null);
    wirePodStore(serialize);
    expect(await loadPodScene()).toBeUndefined();
  });

  // --- ROUND-3 Medium #2: the unload path flushes the pending pod write ------------------
  it("flushes the pending pod write IMMEDIATELY (not left on the 2s debounce)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const el = { id: "a", type: "rectangle" } as unknown as ExcalidrawElement;

    // Enqueue a save onto the pod write's OWN ~2s debounce, then flush WITHOUT advancing the
    // timers — the write must happen now, proving it isn't left on the 2s debounce.
    savePodScene([el], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene();

    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    const sceneWrite = calls.find(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    );
    expect(sceneWrite).toBeDefined();
  });

  it("keepalive:true threads to the scene body PUT (pagehide best-effort)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const el = { id: "a", type: "rectangle" } as unknown as ExcalidrawElement;

    savePodScene([el], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene({ keepalive: true });

    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    const sceneWrite = calls.find(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    );
    expect(sceneWrite).toBeDefined();
    expect(sceneWrite?.[1]?.keepalive).toBe(true);
  });

  it("a plain flush (await-able, e.g. before disconnect) does NOT set keepalive", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const el = { id: "a", type: "rectangle" } as unknown as ExcalidrawElement;

    savePodScene([el], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene();

    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    const sceneWrite = calls.find(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    );
    expect(sceneWrite?.[1]?.keepalive).toBeUndefined();
  });
});

// --- ROUND-4 Medium: durable pending — clear only on a RESOLVED write -------------------
//
// `keepalive: true` bodies are capped at ~64KB by the Fetch spec; an oversized scene PUT
// REJECTS instead of falling back, and if `pending` were cleared before the write resolved
// the save would be lost. These tests pin: (a) a large body at unload does NOT use keepalive,
// (b) a failed / unresolved write does NOT clear `pending` (it survives for retry), and
// (c) a successful flush DOES clear it.
describe("pending durability (clear only on a resolved write)", () => {
  // A serialiser whose body is comfortably over the 64 KiB keepalive cap.
  const bigSerialize = () =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      blob: "x".repeat(70_000),
    });
  const el = () =>
    ({ id: "a", type: "rectangle" } as unknown as ExcalidrawElement);

  it("a LARGE scene body at unload does NOT set keepalive (oversized → normal fetch)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(bigSerialize);
    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene({ keepalive: true });

    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    const sceneWrite = calls.find(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    );
    expect(sceneWrite).toBeDefined();
    // Sanity: the body really is oversized (non-vacuous — the gate fired on size).
    expect(
      new TextEncoder().encode(sceneWrite?.[1]?.body as string).length,
    ).toBeGreaterThan(64 * 1024);
    // keepalive OFF so the request can't reject at the cap and lose the write.
    expect(sceneWrite?.[1]?.keepalive).toBeUndefined();
    // And because the (large) write succeeded here, pending is cleared.
    expect(hasPendingPodScene()).toBe(false);
  });

  it("does NOT lose the pending save when the unload-time write FAILS (survives for retry)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(bigSerialize);
    // Let ACL PUTs succeed, but the scene body PUT FAILS (e.g. the unload window cut it off).
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          return new Response("boom", {
            status: 500,
            statusText: "Server Error",
          });
        }
        return new Response(null, { status: 201 });
      },
    );

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene({ keepalive: true });

    // The write did NOT resolve successfully → the pending snapshot is KEPT for retry.
    expect(hasPendingPodScene()).toBe(true);
  });

  it("retries the kept-pending save on a SUBSEQUENT flush after the write recovers", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    let failNext = true;
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT" &&
          failNext
        ) {
          failNext = false;
          return new Response("boom", { status: 500 });
        }
        return new Response(null, { status: 201 });
      },
    );

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene(); // first attempt fails → pending kept
    expect(hasPendingPodScene()).toBe(true);

    await flushPodScene(); // retry succeeds → pending cleared
    expect(hasPendingPodScene()).toBe(false);
  });

  it("does NOT clear pending while the write has not RESOLVED (in-flight survives)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    let releaseScenePut!: () => void;
    const sceneGate = new Promise<void>((r) => {
      releaseScenePut = r;
    });
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          await sceneGate; // the scene body PUT hangs until released
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 201 });
      },
    );

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    const flushed = flushPodScene();
    // The scene write is in-flight (not resolved) → pending must still be present.
    await Promise.resolve();
    await Promise.resolve();
    expect(hasPendingPodScene()).toBe(true);

    // Release the write; once it resolves, pending is cleared.
    releaseScenePut();
    await flushed;
    expect(hasPendingPodScene()).toBe(false);
  });

  it("a SUCCESSFUL flush clears pending", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    expect(hasPendingPodScene()).toBe(true);
    await flushPodScene();
    expect(hasPendingPodScene()).toBe(false);
  });

  it("debounced save: clears pending on success, keeps it on failure", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);

    // Success path: the debounced write resolves → pending cleared.
    savePodScene([el()], { viewBackgroundColor: "#111" }, {});
    expect(hasPendingPodScene()).toBe(true);
    await vi.runAllTimersAsync();
    expect(hasPendingPodScene()).toBe(false);

    // Failure path: the debounced write 500s → pending kept for retry.
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          return new Response("boom", { status: 500 });
        }
        return new Response(null, { status: 201 });
      },
    );
    savePodScene([el()], { viewBackgroundColor: "#222" }, {});
    await vi.runAllTimersAsync();
    expect(hasPendingPodScene()).toBe(true);
  });

  // --- ROUND-5 Medium: in-flight flush DEDUP (coalesce concurrent flushes) --------------
  //
  // The page-teardown handlers (blur / visibilitychange / pagehide / beforeunload) each
  // fire a synchronous `flushPodScene({ keepalive: true })` for the SAME pending snapshot.
  // The browser caps the AGGREGATE in-flight `keepalive` body size at ~64 KiB across ALL
  // in-flight bodies, so a duplicate keepalive PUT for one snapshot can blow the cap and
  // reject — losing the save. These pin: concurrent flushes coalesce to ONE PUT; success
  // clears pending; failure keeps pending and a later flush retries with a new PUT.

  // A scene-PUT mock whose writes hang on a gate, so several flushes overlap in-flight.
  // Returns { release, count(), reached } — `reached` resolves the FIRST time a scene-body
  // PUT is entered (so a test can deterministically wait until the in-flight write exists
  // before asserting the coalesced count, without sleeping a fixed number of microticks).
  const gatedScenePut = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((r) => {
      signalReached = r;
    });
    let count = 0;
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          count += 1;
          signalReached(); // a scene PUT has begun (resolving `reached` is idempotent)
          await gate; // hold the scene body PUT in-flight until released
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 201 });
      },
    );
    return { release, count: () => count, reached };
  };

  const countScenePuts = () => {
    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    return calls.filter(
      ([url, init]) =>
        url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
    ).length;
  };

  // Flush microtasks (without advancing fake timers) until at least `n` scene-body PUTs
  // have been ISSUED into the (possibly gated) fetch mock, or a bounded number of ticks
  // elapse. Deterministic alternative to a fixed `await Promise.resolve()` count when a
  // PUT is several `await` hops deep (memoised ACL + the body PUT) inside `saveScene`.
  const waitForScenePuts = async (n: number): Promise<void> => {
    for (let i = 0; i < 50 && countScenePuts() < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  };

  // The keepalive flags of every issued scene-body PUT, in call order (round-6 helper).
  const scenePutKeepaliveFlags = (): (boolean | undefined)[] => {
    const calls = sessionFetch().mock.calls as unknown as [
      string,
      RequestInit?,
    ][];
    return calls
      .filter(
        ([url, init]) =>
          url.endsWith(`${DEFAULT_BOARD}.excalidraw`) && init?.method === "PUT",
      )
      .map(([, init]) => init?.keepalive);
  };

  it("coalesces concurrent keepalive flushes of ONE snapshot into a SINGLE PUT", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const { release, count, reached } = gatedScenePut();

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    // Simulate the multiple unload handlers all firing synchronously while the first
    // write is still UNRESOLVED — they must NOT each start a new saveScene/PUT. (The
    // f2..f4 calls run synchronously to their `await startSave(...)`, where startSave
    // returns the SAME in-flight promise instead of issuing a second saveScene.)
    const f1 = flushPodScene({ keepalive: true });
    const f2 = flushPodScene({ keepalive: true });
    const f3 = flushPodScene({ keepalive: true });
    const f4 = flushPodScene({ keepalive: true });

    // Wait until the (single) scene PUT is actually in flight (gated) — exactly ONE issued.
    await reached;
    expect(count()).toBe(1);

    release();
    await Promise.all([f1, f2, f3, f4]);
    // Still exactly one scene PUT total, and on its success pending is cleared.
    expect(countScenePuts()).toBe(1);
    expect(hasPendingPodScene()).toBe(false);
  });

  it("does NOT coalesce after the in-flight write SETTLES — a later flush retries (new PUT)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    // First scene PUT FAILS → pending survives, in-flight slot cleared on settle.
    let failNext = true;
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          if (failNext) {
            failNext = false;
            return new Response("boom", { status: 500 });
          }
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 201 });
      },
    );

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    await flushPodScene({ keepalive: true }); // attempt #1 fails → pending kept
    expect(hasPendingPodScene()).toBe(true);
    expect(countScenePuts()).toBe(1);

    // A SUBSEQUENT flush of the still-pending snapshot is NOT coalesced into the
    // (settled) first one — it issues a fresh PUT, which succeeds and clears pending.
    await flushPodScene({ keepalive: true });
    expect(countScenePuts()).toBe(2);
    expect(hasPendingPodScene()).toBe(false);
  });

  it("a keepalive unload flush overlapping a debounced NON-keepalive save issues its OWN keepalive PUT, and a further keepalive flush then coalesces", async () => {
    // ROUND-6 correction of the original round-5 invariant: a keepalive flush must NOT
    // coalesce onto a NON-keepalive in-flight debounce (that request can be cancelled on
    // teardown). It starts its OWN keepalive PUT — and, once that keepalive save is the
    // tracked in-flight one, a FURTHER concurrent keepalive flush coalesces onto IT (so we
    // still don't fire duplicate keepalive PUTs that could blow the aggregate cap).
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const { release, count, reached } = gatedScenePut();

    // The debounce timer fires FIRST, starting an in-flight NON-keepalive save (gated, not
    // yet resolved, so `pending` is still held for THIS snapshot)…
    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    vi.advanceTimersByTime(2100); // fire the debounce → startSave(state, store, false)
    await reached;
    expect(count()).toBe(1);

    // …then an unload (keepalive) flush of the SAME snapshot arrives. It must NOT coalesce
    // onto the cancellable non-keepalive write — it issues its OWN keepalive PUT.
    const flushed = flushPodScene({ keepalive: true });
    await waitForScenePuts(2); // the keepalive PUT is issued into the (still-gated) mock
    expect(count()).toBe(2);

    // A SECOND keepalive flush now coalesces onto the (keepalive) tracked in-flight save —
    // no third PUT.
    const flushed2 = flushPodScene({ keepalive: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(count()).toBe(2);

    release();
    await Promise.all([flushed, flushed2]);
    // Two PUTs total (the debounce + the single keepalive unload); pending cleared.
    expect(countScenePuts()).toBe(2);
    expect(scenePutKeepaliveFlags()).toContain(true);
    expect(hasPendingPodScene()).toBe(false);
  });

  // --- ROUND-6 High: KEEPALIVE-AWARE coalescing -----------------------------------------
  //
  // Round-5's dedup coalesced a keepalive unload flush onto ANY in-flight save for the same
  // snapshot — INCLUDING a debounced NON-keepalive write. A non-keepalive request can be
  // CANCELLED during page teardown, so coalescing the unload onto it meant NO keepalive PUT
  // was issued → the latest scene was LOST when an unload overlapped a debounced save. The
  // fix: a keepalive flush coalesces ONLY onto a keepalive in-flight save; overlapping a
  // non-keepalive in-flight write, it starts its OWN keepalive PUT. (The round-5 invariant —
  // concurrent KEEPALIVE flushes still collapse to one — is preserved.)

  it("issues a KEEPALIVE PUT when an unload flush overlaps a debounced NON-keepalive save (not coalesced away)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const { release, count, reached } = gatedScenePut();

    // A DEBOUNCED (non-keepalive) write fires FIRST and is in flight (gated, unresolved) —
    // `pending` is still held for THIS snapshot.
    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    vi.advanceTimersByTime(2100); // fire the debounce → startSave(state, store, false)
    await reached;
    expect(count()).toBe(1);
    // The in-flight save is NON-keepalive.
    expect(scenePutKeepaliveFlags()).toEqual([undefined]);

    // …then an unload flush (keepalive) of the SAME snapshot arrives. It must NOT coalesce
    // onto the cancellable non-keepalive write — it must issue its OWN keepalive PUT so the
    // unload save survives page teardown.
    const flushed = flushPodScene({ keepalive: true });
    await waitForScenePuts(2); // the keepalive PUT is issued into the (still-gated) mock
    expect(count()).toBe(2);
    // A keepalive PUT IS present (the unload save is guaranteed), alongside the debounce's.
    expect(scenePutKeepaliveFlags()).toContain(true);

    release();
    await flushed;
    // Two PUTs total: the non-keepalive debounce + the keepalive unload. Both resolve;
    // pending is cleared on success.
    expect(countScenePuts()).toBe(2);
    expect(hasPendingPodScene()).toBe(false);
  });

  it("ROUND-5 invariant preserved: two concurrent KEEPALIVE flushes still coalesce to ONE keepalive PUT", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const { release, count, reached } = gatedScenePut();

    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    // Both flushes are keepalive for the SAME snapshot → coalesce to a single keepalive PUT.
    const f1 = flushPodScene({ keepalive: true });
    const f2 = flushPodScene({ keepalive: true });

    await reached;
    expect(count()).toBe(1);
    expect(scenePutKeepaliveFlags()).toEqual([true]);

    release();
    await Promise.all([f1, f2]);
    expect(countScenePuts()).toBe(1);
    expect(hasPendingPodScene()).toBe(false);
  });

  it("a NON-keepalive flush coalesces onto an in-flight NON-keepalive debounce (no duplicate PUT)", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    const { release, count, reached } = gatedScenePut();

    // A DEBOUNCED (non-keepalive) write fires and is in flight (gated, unresolved)…
    savePodScene([el()], { viewBackgroundColor: "#abc" }, {});
    vi.advanceTimersByTime(2100);
    await reached;
    expect(count()).toBe(1);

    // …then a plain (non-keepalive) flush of the SAME pending snapshot arrives. A
    // non-keepalive save coalesces onto an in-flight save of EITHER flavour, so it must
    // NOT issue a second PUT (a non-keepalive flush has no teardown-cancellation risk).
    const flushed = flushPodScene();
    await Promise.resolve();
    await Promise.resolve();
    expect(count()).toBe(1);

    release();
    await flushed;
    expect(countScenePuts()).toBe(1);
    expect(scenePutKeepaliveFlags()).toEqual([undefined]);
    expect(hasPendingPodScene()).toBe(false);
  });

  it("a late-resolving older save does NOT clobber a NEWER pending edit", async () => {
    setSession(true, CONTAINER, WEBID);
    wirePodStore(serialize);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let scenePutCount = 0;
    sessionFetch().mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          (url as string).endsWith(`${DEFAULT_BOARD}.excalidraw`) &&
          init?.method === "PUT"
        ) {
          scenePutCount += 1;
          if (scenePutCount === 1) {
            await firstGate; // hold the first save's scene PUT in-flight
          }
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 201 });
      },
    );

    savePodScene([el()], { viewBackgroundColor: "#111" }, {});
    const firstFlush = flushPodScene(); // captures snapshot #1, write hangs
    await Promise.resolve();

    // A NEWER edit arrives while #1 is still in-flight.
    savePodScene([el()], { viewBackgroundColor: "#222" }, {});
    expect(hasPendingPodScene()).toBe(true);

    // #1 finally resolves — it must NOT clear the newer pending (#2).
    releaseFirst();
    await firstFlush;
    expect(hasPendingPodScene()).toBe(true);
  });
});
