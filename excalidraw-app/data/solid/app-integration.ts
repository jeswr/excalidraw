// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The App-side glue that binds the Solid lifecycle to the live Excalidraw editor.
 *
 * This is the ONE module allowed to import Excalidraw's editor internals
 * (`serializeAsJSON`, `loadFromBlob`, the imperative API) — the core `data/solid/*`
 * modules stay decoupled + unit-testable behind injected `serialize` / `hydrate` seams.
 *
 *   - {@link sceneSerializer} builds the real serializer the pod store writes with:
 *     `serializeAsJSON(elements, appState, files, "local")` — the byte-exact, self-contained
 *     `.excalidraw` JSON.
 *   - {@link sceneHydrator} builds the hydrate callback: parse the pod-loaded `.excalidraw`
 *     body through the editor's normal import path (`loadFromBlob`) and apply it to the
 *     canvas (`updateScene` + `addFiles`).
 *   - {@link solidLifecycleOptions} bundles both into the `SolidLifecycleOptions` the
 *     lifecycle (`bootstrapSolid` / `connectSolidPod`) consumes.
 */

import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { EXCALIDRAW_MIME } from "./SolidStore";

import type {
  SceneSerializer,
  HydrateScene,
  SolidLifecycleOptions,
} from "./lifecycle";
import type { SceneState } from "./SolidStore";

/**
 * The real Excalidraw scene serializer the pod store writes with — the byte-exact,
 * self-contained `.excalidraw` JSON (`type: "local"`, files inline).
 */
export const sceneSerializer: SceneSerializer = (state: SceneState): string =>
  serializeAsJSON(state.elements, state.appState, state.files, "local");

/**
 * Build the hydrate callback for an editor instance: parse the pod-loaded byte-exact
 * `.excalidraw` body through `loadFromBlob` (the normal import path) and apply it to the
 * live canvas. The body is self-contained (files inline); the controller's `files` map
 * (from sibling blobs) is folded in as a fallback for any image the body lacks.
 *
 * Capture is `NEVER` so the pod-hydrate is not pushed onto the undo stack as a user edit.
 */
export function sceneHydrator(
  excalidrawAPI: ExcalidrawImperativeAPI,
): HydrateScene {
  return async ({ body, files }) => {
    const blob = new Blob([body], { type: EXCALIDRAW_MIME });
    const data = await loadFromBlob(blob, null, null);

    excalidrawAPI.updateScene({
      elements: restoreElements(data.elements, null, {
        repairBindings: true,
      }),
      appState: restoreAppState(data.appState, excalidrawAPI.getAppState()),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    // The byte-exact `.excalidraw` body inlines its files; add them, plus any sibling-blob
    // files the controller reconstituted that the body did not carry.
    const merged = { ...files, ...(data.files ?? {}) };
    const fileList = Object.values(merged);
    if (fileList.length) {
      excalidrawAPI.addFiles(fileList);
    }
  };
}

/** Bundle the serializer + a per-editor hydrator into the lifecycle options. */
export function solidLifecycleOptions(
  excalidrawAPI: ExcalidrawImperativeAPI,
): SolidLifecycleOptions {
  return {
    serialize: sceneSerializer,
    hydrate: sceneHydrator(excalidrawAPI),
  };
}
