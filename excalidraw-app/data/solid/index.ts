// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The Excalidraw→Solid integration — pod persistence for the example app.
 *
 * Public surface:
 *   - SolidStore         — the byte-exact `.excalidraw` scene store (the LocalData seam)
 *   - controller         — the additive, fail-soft save/load bridge from `LocalData`
 *   - session            — reactive-auth + silent session restore + WebID/container
 *   - clientid-document  — the origin-aware Solid Client Identifier Document
 *   - federation         — the `fedreg:Membership` registry builder
 *   - login              — the WebID-first DPoP token provider (static client_id)
 */
export { EXCALIDRAW_MIME, SolidStore } from "./SolidStore";
export type { BoardId, SceneState, SolidStoreConfig } from "./SolidStore";
export {
  DEFAULT_BOARD,
  flushPodScene,
  loadPodScene,
  podStoreReady,
  savePodScene,
  teardownPodStore,
  wirePodStore,
} from "./controller";
export {
  callbackUri,
  clientIdDocumentUrl,
  connectSolid,
  disconnectSolid,
  dpopAuthedFetch,
  drawingsContainer,
  DRAWINGS_NAMESPACE,
  interactiveLogin,
  persistedSolidWebId,
  resolveOidcIssuer,
  resolveStorageRoot,
  setSolidFetch,
  silentRestore,
  solidConnected,
  solidFetch,
  solidWebId,
} from "./session";
export {
  adoptConnectedSession,
  bootstrapSolid,
  connectSolidPod,
  disconnectSolidPod,
} from "./lifecycle";
export type {
  HydrateScene,
  SceneSerializer,
  SolidLifecycleOptions,
} from "./lifecycle";
export {
  buildClientIdDocument,
  DRAWING_SCENE_SHAPE,
  DRAWING_SECTOR,
  normaliseOrigin,
  serializeClientIdDocument,
} from "./clientid-document";
export {
  buildForkRegistry,
  PLACEHOLDER_ASSERTED_BY,
  serializeForkRegistry,
} from "./federation";
export {
  establishContainerAcl,
  ownerOnlyContainerAcl,
  ownerOnlyResourceAcl,
  putResourceAcl,
} from "./acl";
export {
  promptWebIdDialog,
  WebIdDPoPTokenProvider,
} from "./webid-token-provider";
