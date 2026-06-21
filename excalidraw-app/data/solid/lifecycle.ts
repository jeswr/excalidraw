// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The Solid integration LIFECYCLE — the single end-to-end orchestration the Excalidraw
 * example app calls to make pod persistence actually live.
 *
 * THE WIRING THIS FIXES. Round 1 defined `savePodScene` / `wirePodStore` / `connectSolid`
 * / `silentRestore` / `loadPodScene` but NOTHING ever called them, so the pod `store`
 * stayed `null` and pod save/load was DEAD CODE (a no-op). This module is the missing
 * activation: it sequences the calls into the editor's lifecycle.
 *
 *   - {@link bootstrapSolid} runs on app load — SILENT session restore (refresh-grant, NO
 *     popup), and on success `wirePodStore` + `loadPodScene` so a returning user's canvas
 *     hydrates from the pod and subsequent saves persist. On no/failed restore it leaves
 *     the app logged-out (the local localStorage/IndexedDB path is untouched).
 *   - {@link connectSolidPod} is the EXPLICIT "Connect Solid pod" affordance — the ONLY
 *     popup/redirect path: interactive login, then `wirePodStore` + `loadPodScene`.
 *
 * Both wire the store with the REAL Excalidraw scene serializer
 * (`serializeAsJSON(elements, appState, files, "local")`) and the restored/connected
 * authed fetch, so a save writes the actual canvas to an authenticated pod request.
 *
 * Solid is ADDITIVE: when not connected, `wirePodStore` tears the store down and
 * `savePodScene`/`loadPodScene` are no-ops — Excalidraw's local storage path keeps working.
 *
 * Browser-only (auth opens popups / uses IndexedDB); import from client code only.
 */

import { wirePodStore, loadPodScene, teardownPodStore } from "./controller.js";
import {
  connectSolid,
  disconnectSolid,
  interactiveLogin,
  silentRestore,
  solidConnected,
  solidWebId,
} from "./session.js";

import type { SceneState } from "./SolidStore";

/** Serialise a scene to the byte-exact `.excalidraw` body (the app injects the real one). */
export type SceneSerializer = (state: SceneState) => string;

/**
 * Hydrate the editor from a pod-loaded scene. The app passes a callback that
 * `JSON.parse`s + `restore`s the byte-exact body through the editor's normal import path
 * and re-adds the image files (the canvas stays opaque to this layer).
 */
export type HydrateScene = (loaded: {
  body: string;
  files: SceneState["files"];
}) => void | Promise<void>;

export interface SolidLifecycleOptions {
  /** The real Excalidraw scene serializer — `serializeAsJSON(els, appState, files, "local")`. */
  serialize: SceneSerializer;
  /** Apply a pod-loaded scene to the live editor (parse + restore + add files). */
  hydrate: HydrateScene;
}

/** Common tail: wire the store with the real serializer, then hydrate from the pod. */
async function wireAndHydrate(opts: SolidLifecycleOptions): Promise<void> {
  if (!solidConnected()) {
    teardownPodStore();
    return;
  }
  // Wire the pod store with the REAL serializer + the live authed fetch, so the store is
  // non-null and a save writes the actual canvas (this is the call that was missing).
  wirePodStore(opts.serialize);

  // Load the scene from the pod (if one exists) and hand it to the editor to restore.
  const loaded = await loadPodScene();
  if (loaded) {
    await opts.hydrate(loaded);
  }
}

/**
 * On app load: attempt a SILENT session restore (no popup). On success, wire the pod store
 * + hydrate the canvas from the pod. Returns the restored WebID, or `null` (stays
 * logged-out — local storage path untouched, NEVER auto-popups).
 *
 * Fail-soft: any restore/wire/load error leaves the app logged-out; it never throws to the
 * editor boot.
 */
export async function bootstrapSolid(
  opts: SolidLifecycleOptions,
): Promise<string | null> {
  try {
    const webId = await silentRestore();
    if (!webId) {
      teardownPodStore();
      return null;
    }
    await wireAndHydrate(opts);
    return solidWebId();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[solid] bootstrap failed; staying logged-out (no popup):",
      err instanceof Error ? err.message : err,
    );
    teardownPodStore();
    return null;
  }
}

/**
 * EXPLICIT "Connect Solid pod" — interactive login (the only popup path), then wire the
 * pod store + hydrate the canvas from the pod. Returns the connected WebID. Rejects if the
 * user cancels login (the editor stays on the local path); the caller surfaces the error.
 *
 * ALL-OR-NOTHING (round-3 Medium #1 fix). `interactiveLogin` mutates session state
 * (WebID + scoped authed fetch) BEFORE wiring/hydration. If `wireAndHydrate` throws after a
 * successful login, the session/fetch/store would otherwise stay active while the UI is left
 * on the local path — a partial connect. We therefore wrap the post-login wiring in a
 * try/catch and, on failure, fully roll back via {@link disconnectSolidPod} (tear down the
 * store + clear the session/fetch/WebID/container) before rethrowing, so a failed connect
 * leaves NO active Solid session.
 */
export async function connectSolidPod(
  opts: SolidLifecycleOptions,
  initialWebId?: string,
): Promise<string> {
  const webId = await interactiveLogin(initialWebId);
  try {
    await wireAndHydrate(opts);
  } catch (err) {
    // Roll back the just-established session/fetch/store so the connect is all-or-nothing.
    disconnectSolidPod();
    throw err;
  }
  return webId;
}

/** Explicit disconnect: tear down the pod store + clear the session (local path remains). */
export function disconnectSolidPod(): void {
  teardownPodStore();
  disconnectSolid();
}

/**
 * Re-export the additive `connectSolid` so a caller that already has a live authed fetch
 * (e.g. a test, or a future SSO path) can wire-and-hydrate without the interactive popup.
 */
export async function adoptConnectedSession(
  opts: SolidLifecycleOptions,
  webId: string,
): Promise<void> {
  await connectSolid(webId);
  await wireAndHydrate(opts);
}
