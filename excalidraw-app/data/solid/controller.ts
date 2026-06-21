// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The Solid integration controller — the single app-wide seam the Excalidraw example
 * app calls to persist a scene to the user's pod.
 *
 * INTEGRATION MODEL. Excalidraw saves the scene to the browser (localStorage +
 * IndexedDB) via `LocalData` on a debounce, and loads it on boot. This controller
 * MIRRORS that save to the pod when a Solid session is connected, and exposes a
 * pod LOAD for boot-time hydrate. It is deliberately ADDITIVE and fail-soft:
 *
 *   - `savePodScene` is a no-op when no pod is connected, so the existing localStorage
 *     save path is untouched for users who never connect a pod.
 *   - The byte-exact `.excalidraw` body is the source of truth on the pod; localStorage
 *     stays the instant cache (cross-app UX invariant #3 — paint instantly, then
 *     revalidate from the pod).
 *   - Errors are logged, never thrown to the editor — a pod write failing must never
 *     break the user's drawing.
 *
 * The owner-only ACL + fail-closed write ordering live in {@link SolidStore}; this
 * controller only sequences (debounce) + bridges to the live session.
 */

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { SolidStore } from "./SolidStore";

import {
  drawingsContainer,
  solidConnected,
  solidFetch,
  solidWebId,
} from "./session";

import type { SceneState } from "./SolidStore";

/**
 * The board id the example app uses for its single "current" canvas. The example app is
 * single-document (one localStorage scene); we mirror it to one pod board. A multi-board
 * UI would pass a real board id per scene.
 */
export const DEFAULT_BOARD = "default";

/** Debounce window for pod saves (ms) — coalesce a burst of edits into one pod write. */
const POD_SAVE_DEBOUNCE = 2000;

let store: SolidStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: SceneState | null = null;

/**
 * Wire (or re-wire) the controller to the live pod session. Call after a successful
 * login / silent restore (the session module has set the WebID + container). A no-op +
 * teardown when no pod is connected.
 *
 * The serialiser is injected so this module does not pull in Excalidraw's whole
 * `data/json` graph; the app passes the real `serializeAsJSON(…, "local")` — the
 * byte-exact, self-contained `.excalidraw` JSON.
 */
export function wirePodStore(serialize: (state: SceneState) => string): void {
  const container = drawingsContainer();
  const webId = solidWebId();
  if (!solidConnected() || !container || !webId) {
    teardownPodStore();
    return;
  }
  store = new SolidStore({
    container,
    webId,
    fetch: solidFetch(),
    serialize,
  });
}

/** Tear down the pod store (on disconnect / logout). Cancels any pending pod save. */
export function teardownPodStore(): void {
  store = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pending = null;
}

/** True when a pod store is wired and a session is connected. */
export function podStoreReady(): boolean {
  return store !== null && solidConnected();
}

/**
 * Mirror a scene save to the pod — DEBOUNCED + fail-soft. A no-op when no pod is wired,
 * so the call site (in `LocalData.save`) is safe to add unconditionally. The latest
 * pending state wins; errors are logged, never thrown.
 */
export function savePodScene(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): void {
  if (!podStoreReady()) {
    return;
  }
  pending = { elements, appState, files };
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const state = pending;
    pending = null;
    const s = store;
    if (!state || !s) {
      return;
    }
    void s.saveScene(DEFAULT_BOARD, state).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[solid] pod scene save failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });
  }, POD_SAVE_DEBOUNCE);
}

/**
 * Force-flush any pending debounced pod save immediately (e.g. on tab hide / logout).
 * Returns the in-flight save promise so callers may await durability.
 */
export async function flushPodScene(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const state = pending;
  pending = null;
  const s = store;
  if (!state || !s) {
    return;
  }
  try {
    await s.saveScene(DEFAULT_BOARD, state);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[solid] pod scene flush failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Load the scene from the pod for boot-time hydrate — returns the byte-exact
 * `.excalidraw` JSON body + re-assembled files, or `undefined` when there is no pod
 * board yet (first run) / no pod connected. The caller `JSON.parse` + `restore`s the
 * body via the editor's normal import path (the canvas stays opaque to us).
 */
export async function loadPodScene(): Promise<
  { body: string; files: BinaryFiles } | undefined
> {
  if (!podStoreReady() || !store) {
    return undefined;
  }
  try {
    return await store.loadScene(DEFAULT_BOARD);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[solid] pod scene load failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
