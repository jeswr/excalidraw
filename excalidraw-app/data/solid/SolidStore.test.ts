// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it, vi } from "vitest";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { EXCALIDRAW_MIME, SolidStore } from "./SolidStore";

import type { SceneState } from "./SolidStore";

const CONTAINER = "https://alice.pod.example/drawings/";
const WEBID = "https://alice.pod.example/profile/card#me";

/**
 * A tiny in-memory pod: a Map of URL → { body, contentType }. Supports PUT (store),
 * GET (read or 404), and an LDP container listing for GET on a `/`-ending URL. Records
 * the order of writes so we can assert body-before-acl + container-acl-first ordering.
 */
function fakePod() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  const writeOrder: string[] = [];

  const toBytes = (body: BodyInit | null | undefined): Uint8Array => {
    if (body == null) {
      return new Uint8Array();
    }
    if (body instanceof Uint8Array) {
      return body;
    }
    if (typeof body === "string") {
      return new TextEncoder().encode(body);
    }
    if (body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    return new TextEncoder().encode(String(body));
  };

  const fetchImpl = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        writeOrder.push(url);
        const ct =
          (init?.headers as Record<string, string> | undefined)?.[
            "content-type"
          ] ?? "text/plain";
        store.set(url, { body: toBytes(init?.body), contentType: ct });
        return new Response(null, { status: 201, headers: { etag: '"v1"' } });
      }
      if (method === "DELETE") {
        store.delete(url);
        return new Response(null, { status: 205 });
      }
      // GET
      if (url.endsWith("/")) {
        // Container listing: emit ldp:contains for every stored resource directly under it.
        const LDP = "http://www.w3.org/ns/ldp#";
        const children = [...store.keys()].filter(
          (k) =>
            k.startsWith(url) &&
            k !== url &&
            !k.slice(url.length).includes("/"),
        );
        const ttl = `@prefix ldp: <${LDP}> .\n<${url}> a ldp:Container ${
          children.length
            ? `;\n  ldp:contains ${children.map((c) => `<${c}>`).join(", ")}`
            : ""
        } .`;
        return new Response(ttl, {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      const entry = store.get(url);
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      return new Response(entry.body as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": entry.contentType, etag: '"v1"' },
      });
    },
  );

  return { store, writeOrder, fetch: fetchImpl as unknown as typeof fetch };
}

/**
 * A byte-exact serialiser stub standing in for Excalidraw's
 * `serializeAsJSON(elements, appState, files, "database")`. Crucially it produces a
 * deterministic body that the store must store byte-for-byte (and strips inline files,
 * which the store writes as siblings).
 */
const serialize = (state: SceneState): string =>
  JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: state.elements,
      appState: { viewBackgroundColor: state.appState.viewBackgroundColor },
      // "database" mode strips inline files — siblings hold the bytes.
    },
    null,
    2,
  );

function makeStore(pod = fakePod()) {
  return {
    pod,
    store: new SolidStore({
      container: CONTAINER,
      webId: WEBID,
      fetch: pod.fetch,
      serialize,
    }),
  };
}

const imageElement = (fileId: string): ExcalidrawElement =>
  ({
    id: "el1",
    type: "image",
    fileId,
    isDeleted: false,
  } as unknown as ExcalidrawElement);

const PNG_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("SolidStore construction", () => {
  it("rejects a container without a trailing slash", () => {
    expect(
      () =>
        new SolidStore({
          container: "https://alice.pod.example/drawings",
          webId: WEBID,
          serialize,
        }),
    ).toThrow(/trailing slash/);
  });

  it("rejects a non-http(s) WebID", () => {
    expect(
      () =>
        new SolidStore({
          container: CONTAINER,
          webId: "mailto:alice@example.com",
          serialize,
        }),
    ).toThrow(/http\(s\) IRI/);
  });

  it("rejects an unsafe board slug (path traversal)", () => {
    const { store } = makeStore();
    expect(() => store.sceneUrl("../etc")).toThrow(/unsafe slug/);
    expect(() => store.sceneUrl("a/b")).toThrow(/unsafe slug/);
  });
});

describe("scene <-> pod roundtrip (byte-exact)", () => {
  it("saves a scene byte-exact and loads the identical body back", async () => {
    const { store, pod } = makeStore();
    const state: SceneState = {
      elements: [
        { id: "x", type: "rectangle" } as unknown as ExcalidrawElement,
      ],
      appState: { viewBackgroundColor: "#ffeedd" },
      files: {},
    };

    await store.saveScene("board1", state, { title: "My Board" });

    const expectedBody = serialize(state);
    const stored = pod.store.get(store.sceneUrl("board1"));
    expect(stored?.contentType).toBe(EXCALIDRAW_MIME);
    expect(new TextDecoder().decode(stored?.body)).toBe(expectedBody);

    const loaded = await store.loadScene("board1");
    expect(loaded).toBeDefined();
    expect(loaded?.body).toBe(expectedBody); // byte-for-byte identical.
    expect(loaded?.files).toEqual({});
  });

  it("returns undefined when loading a board that does not exist (first run)", async () => {
    const { store } = makeStore();
    expect(await store.loadScene("never-saved")).toBeUndefined();
  });

  it("writes a draw:Scene descriptor pointing at the byte-exact scene resource", async () => {
    const { store } = makeStore();
    await store.saveScene(
      "board1",
      { elements: [], appState: { viewBackgroundColor: "#fff" }, files: {} },
      { title: "Titled" },
    );
    const descriptor = await store.loadDescriptor("board1");
    expect(descriptor).toBeDefined();
    expect(descriptor?.sceneDocument).toBe(store.sceneUrl("board1"));
    expect(descriptor?.title).toBe("Titled");
    expect(descriptor?.viewBackgroundColor).toBe("#fff");
    expect(descriptor?.schemaVersion).toBe("2");
  });
});

describe("image blobs as sibling resources", () => {
  it("writes each file as a sibling and re-assembles them on load", async () => {
    const { store, pod } = makeStore();
    const fileId = "file-abc" as FileId;
    const files: BinaryFiles = {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: PNG_DATAURL as never,
        created: Date.now(),
      },
    };
    const state: SceneState = {
      elements: [imageElement(fileId)],
      appState: {},
      files,
    };

    await store.saveScene("withimg", state);

    // The sibling resource exists, decoded to raw image bytes (NOT a data: URL).
    const siblingUrl = store.fileUrl("withimg", fileId);
    const sibling = pod.store.get(siblingUrl);
    expect(sibling).toBeDefined();
    expect(sibling?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(sibling?.body).startsWith("data:")).toBe(
      false,
    );

    // The scene body itself does NOT carry the inline file bytes (canvas stays small).
    const sceneBody = new TextDecoder().decode(
      pod.store.get(store.sceneUrl("withimg"))?.body,
    );
    expect(sceneBody).not.toContain(PNG_DATAURL);

    // Load re-assembles the file map (re-encoded back to a data: URL for the editor).
    const loaded = await store.loadScene("withimg");
    expect(Object.keys(loaded?.files ?? {})).toEqual([fileId]);
    expect(
      loaded?.files[fileId].dataURL.startsWith("data:image/png;base64,"),
    ).toBe(true);
  });
});

describe("listing boards", () => {
  it("lists only the board ids (from .excalidraw scene resources)", async () => {
    const { store } = makeStore();
    await store.saveScene("alpha", { elements: [], appState: {}, files: {} });
    await store.saveScene("beta", { elements: [], appState: {}, files: {} });
    const boards = await store.listBoards();
    expect(boards.sort()).toEqual(["alpha", "beta"]);
  });

  it("returns [] for a missing container", async () => {
    const pod = fakePod();
    // Make container GET 404.
    pod.fetch = vi.fn(async () => new Response(null, { status: 404 })) as never;
    const store = new SolidStore({
      container: CONTAINER,
      webId: WEBID,
      fetch: pod.fetch,
      serialize,
    });
    expect(await store.listBoards()).toEqual([]);
  });
});

describe("keepalive size-gate (round-4 Medium: no keepalive for oversized bodies)", () => {
  // The encoded scene-body PUT for the scene resource — the request the keepalive flag rides.
  const scenePut = (pod: ReturnType<typeof fakePod>, sceneUrl: string) => {
    const calls = (
      pod.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }
    ).mock.calls;
    return calls.find(
      ([url, init]) => url === sceneUrl && (init?.method ?? "GET") === "PUT",
    );
  };

  it("sets keepalive on a SMALL scene body (within the keepalive budget)", async () => {
    const { store, pod } = makeStore();
    await store.saveScene(
      "small",
      { elements: [], appState: { viewBackgroundColor: "#fff" }, files: {} },
      { keepalive: true },
    );
    const put = scenePut(pod, store.sceneUrl("small"));
    expect(put).toBeDefined();
    // Sanity: the body really is small, so keepalive is genuinely safe (non-vacuous).
    expect(
      new TextEncoder().encode(put?.[1]?.body as string).length,
    ).toBeLessThan(60_000);
    expect(put?.[1]?.keepalive).toBe(true);
  });

  it("does NOT set keepalive on a LARGE scene body (> 64KB) — uses a normal fetch", async () => {
    const pod = fakePod();
    // A serialiser whose body exceeds the 64 KiB keepalive cap (a big scene at unload).
    const bigSerialize = (): string =>
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        blob: "x".repeat(70_000),
      });
    const store = new SolidStore({
      container: CONTAINER,
      webId: WEBID,
      fetch: pod.fetch,
      serialize: bigSerialize,
    });

    await store.saveScene(
      "big",
      { elements: [], appState: {}, files: {} },
      { keepalive: true },
    );

    const put = scenePut(pod, store.sceneUrl("big"));
    expect(put).toBeDefined();
    // Sanity: the body really IS oversized (non-vacuous — proves the gate fired on size).
    expect(
      new TextEncoder().encode(put?.[1]?.body as string).length,
    ).toBeGreaterThan(64 * 1024);
    // keepalive must be OFF so the request does not reject at the cap (it would lose the write).
    expect(put?.[1]?.keepalive).toBeUndefined();
  });

  it("never sets keepalive when not requested, regardless of size", async () => {
    const { store, pod } = makeStore();
    await store.saveScene(
      "nokeep",
      { elements: [], appState: {}, files: {} },
      // no keepalive flag
    );
    const put = scenePut(pod, store.sceneUrl("nokeep"));
    expect(put?.[1]?.keepalive).toBeUndefined();
  });
});

describe("owner-only ordering (fail-closed)", () => {
  it("establishes the container ACL BEFORE any body, then body-before-acl per resource", async () => {
    const { store, pod } = makeStore();
    await store.saveScene("board1", {
      elements: [],
      appState: { viewBackgroundColor: "#fff" },
      files: {},
    });

    const order = pod.writeOrder;
    const containerAclIdx = order.indexOf(`${CONTAINER}.acl`);
    const sceneIdx = order.indexOf(store.sceneUrl("board1"));
    const sceneAclIdx = order.indexOf(`${store.sceneUrl("board1")}.acl`);
    const descIdx = order.indexOf(store.descriptorUrl("board1"));
    const descAclIdx = order.indexOf(`${store.descriptorUrl("board1")}.acl`);

    // Container ACL is established first of everything.
    expect(containerAclIdx).toBe(0);
    // Each body is written before its own .acl.
    expect(sceneIdx).toBeLessThan(sceneAclIdx);
    expect(descIdx).toBeLessThan(descAclIdx);
    // The container ACL precedes all data bodies.
    expect(containerAclIdx).toBeLessThan(sceneIdx);
    expect(containerAclIdx).toBeLessThan(descIdx);
  });

  it("ACL establishment is memoised — one container .acl PUT across multiple saves", async () => {
    const { store, pod } = makeStore();
    await store.saveScene("a", { elements: [], appState: {}, files: {} });
    await store.saveScene("b", { elements: [], appState: {}, files: {} });
    const containerAclPuts = pod.writeOrder.filter(
      (u) => u === `${CONTAINER}.acl`,
    );
    expect(containerAclPuts).toHaveLength(1);
  });

  it("REFUSES to write any body when the container ACL cannot be established (fail-closed)", async () => {
    const pod = fakePod();
    const guarded = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${CONTAINER}.acl` && (init?.method ?? "GET") === "PUT") {
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      }
      return pod.fetch(url, init);
    });
    const store = new SolidStore({
      container: CONTAINER,
      webId: WEBID,
      fetch: guarded as unknown as typeof fetch,
      serialize,
    });
    await expect(
      store.saveScene("board1", { elements: [], appState: {}, files: {} }),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
    // No scene body was written.
    expect(pod.store.get(store.sceneUrl("board1"))).toBeUndefined();
  });
});
