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
 * The single in-flight pod write, plus the snapshot it is saving. Used to COALESCE
 * concurrent flushes (round-5 Medium fix): the page-teardown handlers (blur /
 * visibilitychange / pagehide / beforeunload) can each fire a synchronous
 * `flushPodScene({ keepalive: true })` for the SAME pending snapshot. The browser caps
 * the TOTAL in-flight `keepalive` request-body size at ~64 KiB AGGREGATE across all
 * in-flight bodies, so issuing a duplicate keepalive PUT for the same snapshot can push
 * the aggregate past the cap and reject the request — reintroducing unload-time save
 * loss. We therefore keep at most ONE in-flight save per snapshot: a flush (or debounced
 * write) for a snapshot that is already being saved REUSES the existing promise instead
 * of starting a second `saveScene`. Cleared on settle (success OR failure) so a later
 * flush of the SAME snapshot (e.g. a retry after a failed write) can start fresh.
 */
let inFlight: { state: SceneState; promise: Promise<void> } | null = null;

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
  // Drop the in-flight slot too: a save already started against the old store may still
  // resolve, but it must not coalesce a save for a NEW store wired after teardown. (Its
  // own `.finally` no-ops because `inFlight` will no longer be its entry.)
  inFlight = null;
}

/** True when a pod store is wired and a session is connected. */
export function podStoreReady(): boolean {
  return store !== null && solidConnected();
}

/**
 * True when there is an UNPERSISTED scene snapshot still pending a pod write — i.e. an
 * edit is queued on the debounce, or a previous (unload-time) save did not resolve and
 * was kept for retry. A "saved" state clears this; a failed / unresolved save does not.
 * Lets the app decide whether unsynced work would be lost (e.g. before navigating away).
 */
export function hasPendingPodScene(): boolean {
  return pending !== null;
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
    const s = store;
    if (!state || !s) {
      return;
    }
    // Route through the shared in-flight dedup: if this exact snapshot is already being
    // saved (e.g. by an unload-time flush), reuse that write rather than firing a second
    // one. `pending` is cleared only on the write's success (round-4 durability).
    void startSave(state, s, false);
  }, POD_SAVE_DEBOUNCE);
}

/**
 * Clear the pending snapshot ONLY if it is still the exact state we just persisted — so a
 * fresh edit that arrived during the in-flight write (a NEWER `pending`) is preserved and
 * not clobbered by a late-resolving older save. Identity comparison is sufficient: each
 * `savePodScene` / flush captures the live `pending` object by reference.
 */
function clearPendingIfUnchanged(persisted: SceneState): void {
  if (pending === persisted) {
    pending = null;
  }
}

/**
 * Start (or REUSE) a single in-flight save for a snapshot — the in-flight dedup that the
 * debounced write and every unload-time flush share. If a save for THIS exact snapshot is
 * already in flight, its promise is returned and NO second `saveScene` is issued (so the
 * aggregate keepalive body cap can't be blown by duplicate unload PUTs of one snapshot,
 * and a debounced write + an unload flush of the same snapshot don't double-fire). Only
 * starts a new `saveScene` when nothing is in flight for `state`.
 *
 * On the write's SUCCESS the pending snapshot is cleared (round-4 durability — only on a
 * resolved write, and only if a newer edit hasn't superseded it). On FAILURE the pending
 * snapshot is KEPT for retry. Either way `inFlight` is cleared on settle so a later flush
 * of the same (still-pending) snapshot can retry it.
 */
function startSave(
  state: SceneState,
  s: SolidStore,
  keepalive: boolean,
): Promise<void> {
  // Coalesce: a save for THIS exact snapshot is already running — reuse it (identity match).
  if (inFlight && inFlight.state === state) {
    return inFlight.promise;
  }
  const promise = s.saveScene(DEFAULT_BOARD, state, { keepalive }).then(
    () => {
      clearPendingIfUnchanged(state);
    },
    (err) => {
      // The write didn't resolve: KEEP `pending` so the save is retried (durability).
      // eslint-disable-next-line no-console
      console.warn(
        "[solid] pod scene save failed (non-fatal, kept for retry):",
        err instanceof Error ? err.message : err,
      );
    },
  );
  const entry = { state, promise };
  inFlight = entry;
  // Clear the in-flight slot on settle (success OR failure) so a later flush of the same
  // still-pending snapshot can start a fresh save — but only if THIS save is still the
  // current in-flight one (a newer save for a different snapshot must not be wiped).
  void promise.finally(() => {
    if (inFlight === entry) {
      inFlight = null;
    }
  });
  return promise;
}

/**
 * Force-flush any pending debounced pod save immediately (e.g. on tab hide / logout /
 * disconnect). The pod write has its OWN ~2s debounce, so without this the latest edits can
 * be lost on hide/close; this cancels the debounce and starts the write NOW.
 *
 * Pass `{ keepalive: true }` on the page-teardown path (pagehide/unload/beforeunload) where
 * the caller can't await — the body PUT is then marked `keepalive` so the browser may
 * complete it after the page goes away (best-effort, size-gated under the 64 KiB cap; an
 * oversized body falls back to a normal request — see {@link SolidStore}). When the caller
 * CAN await (e.g. before an explicit disconnect), omit it and `await` the returned promise
 * for durability.
 *
 * DURABILITY (round-4 Medium fix): the pending snapshot is cleared ONLY after the write
 * actually RESOLVES. If the unload-time save fails or can't complete in the unload window
 * (e.g. a large body that fell back to a normal request the browser then cancels), the
 * pending state SURVIVES so it is retried on the next debounce / flush / app load — a
 * best-effort durability guarantee rather than silent loss.
 */
export async function flushPodScene(opts?: {
  keepalive?: boolean;
}): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const state = pending;
  const s = store;
  if (!state || !s) {
    return;
  }
  // COALESCE concurrent flushes (round-5 Medium fix): the multiple unload handlers
  // (blur / visibilitychange / pagehide / beforeunload) each call this synchronously for
  // the SAME pending snapshot. `startSave` reuses a save already in flight for that
  // snapshot instead of issuing a second `saveScene`, so at most ONE keepalive PUT per
  // snapshot is in flight — the aggregate keepalive body cap can't be blown by duplicates.
  // `startSave` never rejects (it logs + keeps `pending` for retry on failure), so the
  // unload handler stays fail-soft without a local try/catch. The pending snapshot is
  // cleared only on the write's success (round-4 durability).
  await startSave(state, s, opts?.keepalive === true);
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
