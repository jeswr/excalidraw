// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Tests for the App-side glue binding the lifecycle to the editor: the REAL serializer is
 * `serializeAsJSON(…, "local")` (byte-exact `.excalidraw`), and the hydrator parses a
 * pod-loaded body back onto the canvas via the editor's normal import path.
 */
import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  sceneSerializer,
  sceneHydrator,
  solidLifecycleOptions,
} from "./app-integration";

describe("sceneSerializer — the real byte-exact .excalidraw serializer", () => {
  it("produces self-contained .excalidraw JSON (type:'local', files inline)", () => {
    const el = {
      id: "img-1",
      type: "image",
      fileId: "file-1",
      isDeleted: false,
    } as unknown as ExcalidrawElement;
    const files = {
      "file-1": {
        id: "file-1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    } as never;

    const body = sceneSerializer({
      elements: [el],
      appState: { viewBackgroundColor: "#fff" },
      files,
    });
    const parsed = JSON.parse(body);

    expect(parsed.type).toBe("excalidraw");
    expect(parsed.source).toBeDefined();
    // "local" inlines the files map (vs "database" which strips it) — self-contained body.
    expect(parsed.files).toBeDefined();
    expect(parsed.files["file-1"]).toBeDefined();
    expect(parsed.elements).toHaveLength(1);
  });
});

describe("sceneHydrator — applies a pod-loaded scene to the editor", () => {
  it("parses the body and updates the scene + adds files", async () => {
    const updateScene = vi.fn();
    const addFiles = vi.fn();
    const getAppState = vi.fn(() => ({} as never));
    const api = {
      updateScene,
      addFiles,
      getAppState,
    } as unknown as ExcalidrawImperativeAPI;

    // A minimal valid .excalidraw body with one inline file.
    const body = sceneSerializer({
      elements: [
        {
          id: "img-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
        } as unknown as ExcalidrawElement,
      ],
      appState: { viewBackgroundColor: "#123456" },
      files: {
        "file-1": {
          id: "file-1",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AAAA",
          created: 1,
        },
      } as never,
    });

    const hydrate = sceneHydrator(api);
    await hydrate({ body, files: {} });

    expect(updateScene).toHaveBeenCalledTimes(1);
    // The inline file from the body is added to the editor.
    expect(addFiles).toHaveBeenCalledTimes(1);
    const added = addFiles.mock.calls[0][0] as Array<{ id: string }>;
    expect(added.some((f) => f.id === "file-1")).toBe(true);
  });

  it("a body with no files does not call addFiles", async () => {
    const updateScene = vi.fn();
    const addFiles = vi.fn();
    const api = {
      updateScene,
      addFiles,
      getAppState: () => ({}),
    } as unknown as ExcalidrawImperativeAPI;

    const body = sceneSerializer({
      elements: [],
      appState: {},
      files: {} as never,
    });
    await sceneHydrator(api)({ body, files: {} });

    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(addFiles).not.toHaveBeenCalled();
  });
});

describe("solidLifecycleOptions", () => {
  it("bundles the real serializer + a per-editor hydrator", () => {
    const api = {
      updateScene: vi.fn(),
      addFiles: vi.fn(),
      getAppState: () => ({}),
    } as unknown as ExcalidrawImperativeAPI;
    const opts = solidLifecycleOptions(api);
    expect(opts.serialize).toBe(sceneSerializer);
    expect(opts.hydrate).toBeTypeOf("function");
  });
});
