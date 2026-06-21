// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import * as session from "./session";
import {
  DEFAULT_BOARD,
  flushPodScene,
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
