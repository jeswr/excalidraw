// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Tests proving the Solid integration is ACTUALLY WIRED — not dead code.
 *
 * The round-1 HIGH: `savePodScene` / `wirePodStore` / `loadPodScene` were defined but
 * NEVER called, so the pod `store` stayed `null` and pod save/load was a no-op. These
 * tests drive the REAL lifecycle (bootstrapSolid / connectSolidPod) against the REAL
 * controller + SolidStore (only the session/auth seam is mocked) and assert:
 *
 *   - silentRestore → connect → wirePodStore makes the store non-null AND a save writes the
 *     SERIALIZED scene to the pod (the live wiring);
 *   - loadPodScene hydrates the editor from the pod on bootstrap;
 *   - when NOT connected, bootstrap is a no-op and a save makes NO pod calls (local path);
 *   - the interactive "Connect Solid pod" affordance is the path that connects + wires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  bootstrapSolid,
  connectSolidPod,
  disconnectSolidPod,
} from "./lifecycle";
import { podStoreReady, savePodScene, teardownPodStore } from "./controller";

const CONTAINER = "https://alice.pod.example/drawings/";
const WEBID = "https://alice.pod.example/profile/card#me";

// --- session/auth seam mock ------------------------------------------------
// We control the session module so the lifecycle's connect + silent-restore are
// deterministic, and the controller reads a fetch we inspect for pod calls.
let connected = false;
let podFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
  return new Response(null, { status: 201, headers: { etag: '"v1"' } });
});
const silentRestoreMock = vi.fn<() => Promise<string | null>>();
const interactiveLoginMock = vi.fn<(webId?: string) => Promise<string>>();
const connectSolidMock = vi.fn<(webId: string) => Promise<void>>(async () => {
  connected = true;
});

vi.mock("./session", () => ({
  silentRestore: () => silentRestoreMock(),
  interactiveLogin: (webId?: string) => interactiveLoginMock(webId),
  connectSolid: (webId: string) => connectSolidMock(webId),
  disconnectSolid: () => {
    connected = false;
  },
  solidConnected: () => connected,
  drawingsContainer: () => (connected ? CONTAINER : null),
  solidWebId: () => (connected ? WEBID : null),
  solidFetch: () => podFetch as unknown as typeof fetch,
}));

const SERIALIZED = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [{ id: "rect-1", type: "rectangle" }],
  appState: { viewBackgroundColor: "#abcdef" },
  files: {},
});

const serialize = vi.fn(() => SERIALIZED);
const hydrate = vi.fn<
  (loaded: { body: string; files: Record<string, unknown> }) => Promise<void>
>(async () => {});

const opts = () => ({ serialize, hydrate });

beforeEach(() => {
  vi.useFakeTimers();
  connected = false;
  serialize.mockClear();
  hydrate.mockClear();
  silentRestoreMock.mockReset();
  interactiveLoginMock.mockReset();
  connectSolidMock.mockClear();
  podFetch = vi.fn(
    async () => new Response(null, { status: 201, headers: { etag: '"v1"' } }),
  );
  teardownPodStore();
});

afterEach(() => {
  vi.useRealTimers();
  teardownPodStore();
});

const el = { id: "rect-1", type: "rectangle" } as unknown as ExcalidrawElement;

describe("bootstrapSolid — silent restore activates the wiring", () => {
  it("on a restored session: connect + wirePodStore make the store non-null", async () => {
    silentRestoreMock.mockImplementation(async () => {
      connected = true; // the real silentRestore connects on success
      return WEBID;
    });

    const webId = await bootstrapSolid(opts());

    expect(webId).toBe(WEBID);
    // THE FIX: the store is wired (non-null) after bootstrap — no longer dead code.
    expect(podStoreReady()).toBe(true);
  });

  it("a save AFTER restore writes the SERIALIZED scene to the pod (live, not a no-op)", async () => {
    silentRestoreMock.mockImplementation(async () => {
      connected = true;
      return WEBID;
    });
    await bootstrapSolid(opts());

    savePodScene([el], { viewBackgroundColor: "#abcdef" }, {});
    await vi.runAllTimersAsync();

    // The serializer was invoked AND the serialized body was PUT to the scene resource.
    expect(serialize).toHaveBeenCalled();
    const calls = podFetch.mock.calls as unknown as [string, RequestInit?][];
    const sceneWrite = calls.find(
      ([url, init]) =>
        url.endsWith("default.excalidraw") && init?.method === "PUT",
    );
    expect(sceneWrite).toBeDefined();
    expect(sceneWrite?.[1]?.body).toBe(SERIALIZED);
  });

  it("loadPodScene hydrates the editor from the pod on bootstrap", async () => {
    // The pod already has a scene → GET returns it; bootstrap should hydrate.
    podFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        return new Response(null, { status: 201, headers: { etag: '"v1"' } });
      }
      if (url.endsWith("default.excalidraw")) {
        return new Response(SERIALIZED, {
          status: 200,
          headers: { "content-type": "application/vnd.excalidraw+json" },
        });
      }
      return new Response(null, { status: 404 });
    });
    silentRestoreMock.mockImplementation(async () => {
      connected = true;
      return WEBID;
    });

    await bootstrapSolid(opts());

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0][0].body).toBe(SERIALIZED);
  });

  it("no remembered session: bootstrap stays on the local path (store null, no hydrate)", async () => {
    silentRestoreMock.mockResolvedValue(null);

    const webId = await bootstrapSolid(opts());

    expect(webId).toBeNull();
    expect(podStoreReady()).toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe("NOT connected → local fallback, NO pod calls", () => {
  it("a save with no pod connected makes zero pod fetch calls", async () => {
    silentRestoreMock.mockResolvedValue(null);
    await bootstrapSolid(opts()); // stays logged-out

    savePodScene([el], {}, {});
    await vi.runAllTimersAsync();

    expect(podStoreReady()).toBe(false);
    expect(podFetch).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });
});

describe("connectSolidPod — the explicit (popup) affordance", () => {
  it("interactive login connects + wires the store; silentRestore is NOT invoked", async () => {
    interactiveLoginMock.mockImplementation(async () => {
      connected = true; // interactiveLogin connects on success
      return WEBID;
    });

    const webId = await connectSolidPod(opts());

    expect(webId).toBe(WEBID);
    expect(interactiveLoginMock).toHaveBeenCalledTimes(1);
    expect(silentRestoreMock).not.toHaveBeenCalled();
    expect(podStoreReady()).toBe(true);
  });

  it("a save AFTER interactive connect persists the serialized scene to the pod", async () => {
    interactiveLoginMock.mockImplementation(async () => {
      connected = true;
      return WEBID;
    });
    await connectSolidPod(opts());

    savePodScene([el], {}, {});
    await vi.runAllTimersAsync();

    const calls = podFetch.mock.calls as unknown as [string, RequestInit?][];
    expect(
      calls.some(
        ([url, init]) =>
          url.endsWith("default.excalidraw") && init?.method === "PUT",
      ),
    ).toBe(true);
  });

  it("disconnect tears the store down (back to the local path)", async () => {
    interactiveLoginMock.mockImplementation(async () => {
      connected = true;
      return WEBID;
    });
    await connectSolidPod(opts());
    expect(podStoreReady()).toBe(true);

    disconnectSolidPod();
    expect(podStoreReady()).toBe(false);
  });
});
